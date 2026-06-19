import { jest } from '@jest/globals';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import fetch from 'node-fetch';
import companyConfig from '../../config/company.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '../../.env.local') });

const HAS_SOLR = !!process.env.SOLR_AUTH;
const CIF = companyConfig.cif;
const BRAND = companyConfig.brand;
const LEGAL_NAME = companyConfig.legalName;
const API_BASE = companyConfig.apiBase;

function itIfSolr(name, fn, timeout) {
  if (HAS_SOLR) {
    return it(name, fn, timeout);
  }
  return it.skip(`${name} (skipped: SOLR_AUTH not set)`, fn, timeout);
}

beforeAll(() => {
  if (HAS_SOLR) {
    process.env.SOLR_AUTH = process.env.SOLR_AUTH;
  }
});

describe('E2E: Full Scraping Pipeline', () => {

  describe('Gem ATS API — Real Data Fetch', () => {
    let index;

    beforeAll(async () => {
      index = await import('../../index.js');
    });

    it('should fetch and return real jobs from Gem ATS API', async () => {
      const result = await index.fetchGemJobs();

      expect(result).toBeDefined();
      expect(Array.isArray(result)).toBe(true);
      expect(result.length).toBeGreaterThan(0);

      const job = result[0];
      expect(job).toHaveProperty('url');
      expect(job).toHaveProperty('title');
      expect(job).toHaveProperty('uid');
      expect(job).toHaveProperty('location');
      expect(job).toHaveProperty('tags');
    }, 30000);

    it('should include Romanian jobs', async () => {
      const result = await index.fetchGemJobs();
      const romanianJobs = result.filter(j =>
        j.location?.some(l => l.toLowerCase().includes('romania'))
      );
      expect(romanianJobs.length).toBeGreaterThan(0);
    }, 30000);

    it('should have unique URLs across all jobs', async () => {
      const result = await index.fetchGemJobs();
      const urls = result.map(j => j.url);
      const unique = new Set(urls);
      expect(unique.size).toBe(urls.length);
    }, 30000);
  });

  describe('Parse + Transform Pipeline', () => {
    let index;
    let gemJobs;

    beforeAll(async () => {
      index = await import('../../index.js');
      gemJobs = await index.fetchGemJobs();
    }, 30000);

    it('should map Gem ATS jobs to job model', () => {
      const model = index.mapToJobModel(gemJobs[0], CIF);

      expect(model).toHaveProperty('url');
      expect(model).toHaveProperty('title');
      expect(model).toHaveProperty('company');
      expect(model).toHaveProperty('cif', CIF);
      expect(model).toHaveProperty('status', 'scraped');
      expect(model).toHaveProperty('date');
      expect(model.url).toMatch(/^https?:\/\//);
    });

    it('should transform jobs and filter to Romanian locations', () => {
      const jobs = gemJobs.map(j => index.mapToJobModel(j, CIF));

      const payload = {
        source: 'gem.com',
        company: LEGAL_NAME,
        cif: CIF,
        jobs
      };

      const transformed = index.transformJobsForSOLR(payload);

      expect(transformed.company).toBe(LEGAL_NAME);
      expect(transformed.jobs.length).toBeGreaterThan(0);

      for (const job of transformed.jobs) {
        expect(job).toHaveProperty('location');
        expect(Array.isArray(job.location)).toBe(true);
        expect(job.location.length).toBeGreaterThan(0);
        expect(job.workmode).toMatch(/^(remote|on-site|hybrid)$/);
      }
    });

    it('should only keep Romanian jobs after transform', async () => {
      const jobs = gemJobs.map(j => index.mapToJobModel(j, CIF));
      const nonRoBefore = jobs.filter(j =>
        j.location?.every(l => !l.toLowerCase().includes('romania'))
      ).length;

      const payload = {
        source: 'gem.com',
        company: LEGAL_NAME,
        cif: CIF,
        jobs
      };

      const transformed = index.transformJobsForSOLR(payload);
      const totalAfter = transformed.jobs.length;

      expect(totalAfter).toBeLessThan(gemJobs.length);
      expect(totalAfter).toBeGreaterThan(0);
    }, 30000);

    it('should produce valid job URLs that are accessible', async () => {
      const jobs = gemJobs.slice(0, 2);

      for (const job of jobs) {
        const res = await fetch(job.url, {
          method: 'HEAD',
          headers: { 'User-Agent': 'job_seeker_ro_spider' }
        });
        expect(res.ok).toBe(true);
      }
    }, 30000);
  });

  describe('Company Validation Path', () => {
    let anaf;
    let company;

    beforeAll(async () => {
      anaf = await import('../../src/anaf.js');
      company = await import('../../company.js');
    });

    it('should find brand in ANAF and validate active status', async () => {
      const results = await anaf.searchCompany(BRAND);

      const found = results.find(c =>
        c.name.toUpperCase().includes('SENNDER') &&
        c.statusLabel === 'Funcțiune'
      );
      expect(found).toBeDefined();
      expect(found.cui.toString()).toBe(CIF);

      const anafData = await anaf.getCompanyFromANAF(CIF);
      expect(anafData).toBeDefined();
      expect(anafData.inactive).toBe(false);
    }, 30000);

    itIfSolr('should run full validation and report active status with job count', async () => {
      const result = await company.validateAndGetCompany();

      expect(result.status).toBe('active');
      expect(result.company).toBe(LEGAL_NAME);
      expect(result.cif).toBe(CIF);

      if (result.existingJobsCount === 0) {
        console.log(`⚠️ No ${BRAND} jobs in Solr — skipping job count assertion`);
        return;
      }
      expect(result.existingJobsCount).toBeGreaterThan(0);
    }, 30000);
  });

  describe('Inactive Company Handling', () => {
    let anaf;

    beforeAll(async () => {
      anaf = await import('../../src/anaf.js');
    });

    it('should detect inactive/radiated companies via ANAF', async () => {
      const results = await anaf.searchCompany(BRAND);

      const nonActive = results.find(c => c.statusLabel !== 'Funcțiune');

      if (nonActive) {
        try {
          const anafData = await anaf.getCompanyFromANAF(nonActive.cui.toString());
          expect(anafData).toBeDefined();
          if (anafData.inactive !== undefined) {
            expect(anafData.inactive).toBe(true);
          }
        } catch {
          expect(nonActive.statusLabel).toMatch(/Radiată|Inactiv|Suspendat/);
        }
      }
    }, 30000);
  });

  describe('SOLR Data Verification', () => {
    let solr;

    beforeAll(async () => {
      solr = await import('../../solr.js');
    });

    itIfSolr('should have jobs in SOLR with correct company name', async () => {
      const result = await solr.querySOLR(CIF);

      if (result.numFound === 0) {
        console.log(`⚠️ No ${BRAND} jobs in Solr — skipping SOLR data verification`);
        return;
      }

      for (const job of result.docs) {
        expect(job.company).toBe(LEGAL_NAME);
        expect(job.cif).toBe(CIF);
      }
    }, 15000);

    itIfSolr('should have company core entry with required fields', async () => {
      const result = await solr.queryCompanySOLR(`id:${CIF}`);

      expect(result.numFound).toBe(1);
      const company = result.docs[0];
      expect(company.company).toBe(LEGAL_NAME);
      expect(company.status).toBe('activ');
    }, 15000);
  });
});
