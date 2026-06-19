import fetch from "node-fetch";
import fs from "fs";
import { fileURLToPath } from "url";
import { validateAndGetCompany } from "./company.js";
import { querySOLR, deleteJobByUrl, upsertJobs, upsertCompany } from "./solr.js";
import { generateJobsMarkdown } from "./src/markdown-generator.js";
import companyConfig from "./config/company.js";

const COMPANY_CIF = companyConfig.cif;
const API_BASE = companyConfig.apiBase;

const TIMEOUT = 10000;

let COMPANY_NAME = null;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function searchANOFM(cif) {
  const jobs = [];
  try {
    console.log(`Searching ANOFM by CIF: ${cif}`);
    const payload = {
      current: 1,
      rowCount: 250,
      sort: { created_at: "desc" },
      employer_tax_code: cif
    };
    const res = await fetch("https://mediere.anofm.ro/api/entity/vw_public_job_posting", {
      method: "POST",
      timeout: TIMEOUT,
      headers: {
        "Content-Type": "application/json",
        "User-Agent": "job_seeker_ro_spider"
      },
      body: JSON.stringify(payload)
    });
    if (!res.ok) {
      console.log(`  ANOFM returned ${res.status}`);
      return jobs;
    }
    const data = await res.json();
    for (const row of data.rows || []) {
      const locationParts = (row.address_locality_name || '').split('>').map(s => s.trim());
      const location = locationParts.length > 1 ? locationParts[locationParts.length - 1] : locationParts[0];
      jobs.push({
        url: `https://mediere.anofm.ro/app/module/mediere/job/${row.id}`,
        title: row.occupation,
        location: location ? [location] : undefined,
        source: "ANOFM"
      });
    }
    console.log(`  Found ${jobs.length} jobs on ANOFM`);
  } catch (err) {
    console.log(`  ANOFM error: ${err.message}`);
  }
  return jobs;
}

async function fetchGemJobs() {
  console.log(`Fetching Gem API: ${API_BASE}/job_posts/`);
  const res = await fetch(`${API_BASE}/job_posts/`, {
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
      "Accept": "application/json",
      "Referer": "https://jobs.gem.com/senndertechnologies-gmbh",
      "Origin": "https://jobs.gem.com"
    }
  });
  if (!res.ok) {
    throw new Error(`Gem API error ${res.status}`);
  }
  const data = await res.json();
  if (!Array.isArray(data)) {
    throw new Error(`Expected array from Gem API, got ${typeof data}`);
  }
  const allJobs = [];
  for (const post of data) {
    if (!post.requisition_id) continue;
    const location = [];
    if (post.location?.name) {
      location.push(post.location.name);
    }
    if (post.offices) {
      for (const office of post.offices) {
        if (office.name && !location.includes(office.name)) {
          location.push(office.name);
        }
      }
    }
    if (post.country) {
      const countryName = typeof post.country === 'string' ? post.country : post.country.name;
      if (countryName && !location.includes(countryName)) {
        location.push(countryName);
      }
    }
    allJobs.push({
      url: post.absolute_url || `${API_BASE}/job_posts/${post.requisition_id}`,
      title: post.title,
      uid: post.requisition_id,
      location: location.length > 0 ? location : undefined,
      tags: (post.departments || []).map(d => d.name?.toLowerCase()).filter(Boolean),
      workmode: post.location_type || undefined
    });
  }
  console.log(`Gem API: ${allJobs.length} jobs`);
  return allJobs;
}

function mapToJobModel(rawJob, cif, companyName = COMPANY_NAME) {
  const now = new Date().toISOString();
  const job = {
    url: rawJob.url,
    title: rawJob.title,
    company: companyName,
    cif: cif,
    location: rawJob.location?.length ? rawJob.location : undefined,
    tags: rawJob.tags?.length ? rawJob.tags : undefined,
    workmode: rawJob.workmode || undefined,
    date: now,
    status: "scraped"
  };
  Object.keys(job).forEach((k) => job[k] === undefined && delete job[k]);
  return job;
}

function transformJobsForSOLR(payload) {
  const romanianKeywords = ['romania', 'românia', 'bucharest', 'bucurești', 'cluj', 'timișoara', 'timisoara', 'iași', 'iasi', 'brașov', 'brasov', 'constanța', 'constanta', 'craiova', 'sibiu', 'oradea', 'arad', 'baia mare', 'satu mare', 'ploiești', 'ploiesti', 'brăila', 'braila', 'târgu mureș', 'targu mures', 'bacău', 'bacau', 'suceava', 'piatra neamț', 'piatra neamt', 'giurgiu', 'tulcea', 'buzău', 'buzau', 'bistrița', 'bistrita', 'drobeta', 'râmnicu vâlcea', 'ramnicu valcea', 'alba iulia', 'zalău', 'zalau', 'deva', 'hunedoara', 'slatina', 'călărași', 'calarasi', 'voluntari', 'dumbrăvița', 'dumbravita', 'otopeni', 'popești-leordeni', 'popesti-leordeni', 'chitila', 'mogoșoaia', 'mogosoaia'];

  const normalizeWorkmode = (wm) => {
    if (!wm) return undefined;
    const lower = wm.toLowerCase();
    if (lower.includes('remote')) return 'remote';
    if (lower.includes('office') || lower.includes('on-site') || lower.includes('site')) return 'on-site';
    return 'hybrid';
  };

  const isRomanianLocation = (loc) => {
    const lower = loc.toLowerCase().trim();
    if (lower === 'romania' || lower === 'românia') return true;
    return romanianKeywords.some(k => lower.includes(k));
  };

  const transformed = {
    ...payload,
    company: payload.company?.toUpperCase(),
    jobs: payload.jobs.map(job => {
      const validLocations = (job.location || []).filter(loc => {
        const parts = loc.split(/[,;]/).map(s => s.trim()).filter(Boolean);
        return parts.some(p => isRomanianLocation(p));
      }).map(loc => {
        const lower = loc.toLowerCase().trim();
        if (lower === 'romania') return 'România';
        const parts = loc.split(/[,;]/).map(s => s.trim()).filter(Boolean);
        if (parts.length > 1) {
          const roPart = parts.find(p => isRomanianLocation(p));
          return roPart || parts[0];
        }
        return loc;
      });
      return {
        ...job,
        location: validLocations.length > 0 ? [...new Set(validLocations)] : undefined,
        workmode: normalizeWorkmode(job.workmode)
      };
    })
  };

  transformed.jobs = transformed.jobs.filter(j => j.location);
  return transformed;
}

async function main() {
  const testOnlyOnePage = process.argv.includes("--test");
  try {
    fs.mkdirSync("tmp", { recursive: true });
    console.log("=== Step 1: Get existing jobs count ===");
    const existingResult = await querySOLR(COMPANY_CIF);
    const existingCount = existingResult.numFound;
    console.log(`Found ${existingCount} existing jobs in SOLR`);

    console.log("=== Step 2: Validate company via ANAF ===");
    const { company, cif, address } = await validateAndGetCompany();
    COMPANY_NAME = company;
    const localCif = cif;

    try {
      await upsertCompany({
        id: cif,
        company,
        brand: companyConfig.brand,
        status: "activ",
        location: address ? [address] : [companyConfig.defaultLocation],
        website: [companyConfig.website],
        career: [companyConfig.careerUrl],
        lastScraped: new Date().toISOString().split('T')[0],
        scraperFile: companyConfig.scraperFile
      });
    } catch (err) {
      console.log(`Note: Could not upsert company to SOLR core: ${err.message}`);
    }

    console.log("=== Step 3: Scrape jobs from Gem API ===");
    const rawJobs = await fetchGemJobs();
    const scrapedCount = rawJobs.length;
    console.log(`Jobs scraped from Gem: ${scrapedCount}`);

    if (!testOnlyOnePage) {
      const anofmJobs = await searchANOFM(localCif);
      for (const job of anofmJobs) {
        if (!rawJobs.find(j => j.url === job.url)) {
          rawJobs.push(job);
        }
      }
      console.log(`Jobs added from ANOFM: ${anofmJobs.length}`);
    }

    const jobs = rawJobs.map(job => mapToJobModel(job, localCif));
    const payload = {
      source: "gem.com",
      scrapedAt: new Date().toISOString(),
      company: COMPANY_NAME,
      cif: localCif,
      jobs
    };

    console.log("Transforming jobs for SOLR...");
    const transformedPayload = transformJobsForSOLR(payload);
    const validCount = transformedPayload.jobs.length;
    console.log(`Jobs with valid Romanian locations: ${validCount}`);

    fs.writeFileSync("tmp/jobs.json", JSON.stringify(transformedPayload, null, 2), "utf-8");
    console.log("Saved tmp/jobs.json");

    const companyData = {
      id: localCif,
      company: transformedPayload.company,
      brand: companyConfig.brand,
      status: "activ",
      location: address ? [address] : [companyConfig.defaultLocation],
      website: [companyConfig.website],
      career: [companyConfig.careerUrl],
      lastScraped: new Date().toISOString().split('T')[0]
    };
    const markdown = generateJobsMarkdown(companyData, transformedPayload.jobs);
    fs.mkdirSync("docs", { recursive: true });
    fs.writeFileSync("docs/jobs.md", markdown, "utf-8");
    console.log("Saved docs/jobs.md");

    fs.writeFileSync("docs/company.json", JSON.stringify(companyConfig, null, 2), "utf-8");
    console.log("Saved docs/company.json");

    console.log("\n=== Step 6: Upsert jobs to SOLR ===");
    await upsertJobs(transformedPayload.jobs);

    const finalResult = await querySOLR(COMPANY_CIF);
    console.log(`\n=== SUMMARY ===`);
    console.log(`Jobs existing in SOLR before scrape: ${existingCount}`);
    console.log(`Jobs scraped from Gem: ${scrapedCount}`);
    console.log(`Jobs with valid RO locations: ${validCount}`);
    console.log(`Jobs in SOLR after scrape: ${finalResult.numFound}`);
    console.log(`===============`);

    console.log("\n=== DONE ===");
    console.log("Scraper completed successfully!");

  } catch (err) {
    console.error("Scraper failed:", err);
    process.exit(1);
  }
}

export { fetchGemJobs, mapToJobModel, transformJobsForSOLR };

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}
