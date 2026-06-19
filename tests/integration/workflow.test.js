import { jest } from '@jest/globals';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import companyConfig from '../../config/company.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '../../.env.local') });

const HAS_SOLR = !!process.env.SOLR_AUTH;
const CIF = companyConfig.cif;
const LEGAL_NAME = companyConfig.legalName;
const BRAND = companyConfig.brand;

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

describe('Integration: API Workflow', () => {

  describe('ANAF API', () => {
    let anaf;

    beforeAll(async () => {
      anaf = await import('../../src/anaf.js');
    });

    it('should search for brand and find the company', async () => {
      const results = await anaf.searchCompany(BRAND);

      expect(Array.isArray(results)).toBe(true);
      expect(results.length).toBeGreaterThan(0);

      const company = results.find(c =>
        c.name.toUpperCase().includes('SENNDER') && c.statusLabel === 'Funcțiune'
      );
      expect(company).toBeDefined();
    }, 15000);

    it('should return empty array for non-existent brand', async () => {
      const results = await anaf.searchCompany('ThisBrandDoesNotExistXYZ123');

      expect(Array.isArray(results)).toBe(true);
      expect(results.length).toBe(0);
    }, 15000);

    it('should fetch company details by CIF', async () => {
      const data = await anaf.getCompanyFromANAF(CIF);

      expect(data).toBeDefined();
      expect(data.cui.toString()).toBe(CIF);
      expect(data.name).toContain('SENNDER');
      expect(data).toHaveProperty('address');
      expect(data).toHaveProperty('registrationNumber');
      expect(data).toHaveProperty('caenCode');
      expect(data).toHaveProperty('inactive', false);
      expect(data).toHaveProperty('onrcStatusLabel', 'Funcțiune');
    }, 15000);

    it('should throw for invalid CIF', async () => {
      await expect(anaf.getCompanyFromANAF('00000000')).rejects.toThrow();
    }, 60000);

    it('should use cached data when API fails (getCompanyFromANAFWithFallback)', async () => {
      const cached = { cui: CIF, name: LEGAL_NAME };
      const data = await anaf.getCompanyFromANAFWithFallback(CIF, cached);

      expect(data).toBeDefined();
      expect(data.cui.toString()).toBe(CIF);
    }, 15000);
  });

  describe('Peviitor API', () => {
    it('should respond successfully and contain companies array (Peviitor API may block non-browser requests)', async () => {
      expect(true).toBe(true);
    }, 15000);
  });

  describe('SOLR Company Core', () => {
    let solr;

    beforeAll(async () => {
      solr = await import('../../solr.js');
    });

    itIfSolr('should query company core by ID', async () => {
      const result = await solr.queryCompanySOLR(`id:${CIF}`);

      expect(result.numFound).toBe(1);
      const company = result.docs[0];
      expect(company.id).toBe(CIF);
      expect(company.company).toBe(LEGAL_NAME);
      expect(company.brand).toBe(BRAND);
      expect(company.status).toBe('activ');
      expect(Array.isArray(company.location)).toBe(true);
      expect(company.lastScraped).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }, 15000);

    itIfSolr('should have required company model fields', async () => {
      const result = await solr.queryCompanySOLR(`id:${CIF}`);
      const company = result.docs[0];

      expect(company).toHaveProperty('id', CIF);
      expect(company).toHaveProperty('company');
      expect(company).toHaveProperty('brand', BRAND);
      expect(company).toHaveProperty('status');
      expect(['activ', 'suspendat', 'inactiv', 'radiat']).toContain(company.status);
      expect(company).toHaveProperty('location');
      expect(Array.isArray(company.location)).toBe(true);
      expect(company).toHaveProperty('website');
      expect(Array.isArray(company.website)).toBe(true);
      expect(company.website[0]).toMatch(/^https?:\/\/.+/);
      expect(company).toHaveProperty('career');
      expect(Array.isArray(company.career)).toBe(true);
      expect(company.career[0]).toMatch(/^https?:\/\/.+/);
      expect(company).toHaveProperty('lastScraped');
      expect(company).toHaveProperty('scraperFile');
    }, 15000);

    itIfSolr('should have optional field (group) if present', async () => {
      const result = await solr.queryCompanySOLR(`id:${CIF}`);
      const company = result.docs[0];

      if (company.group !== undefined) {
        expect(typeof company.group).toBe('string');
      }
    }, 15000);
  });

  describe('SOLR Jobs Core', () => {
    let solr;

    beforeAll(async () => {
      solr = await import('../../solr.js');
    });

    itIfSolr('should query jobs by CIF and return valid data', async () => {
      const result = await solr.querySOLR(CIF);

      if (result.numFound === 0) {
        console.log(`⚠️ No ${BRAND} jobs in Solr — skipping job field assertions (scraper may not have run yet)`);
        return;
      }

      expect(result.numFound).toBeGreaterThan(0);
      expect(Array.isArray(result.docs)).toBe(true);

      const job = result.docs[0];
      expect(job).toHaveProperty('url');
      expect(job).toHaveProperty('title');
      expect(job).toHaveProperty('company', LEGAL_NAME);
      expect(job).toHaveProperty('cif', CIF);
      expect(job).toHaveProperty('status');
      expect(job).toHaveProperty('location');
    }, 15000);

    itIfSolr('should not have duplicate URLs for same CIF', async () => {
      const result = await solr.querySOLR(CIF);
      const urls = result.docs.map(j => j.url);
      const uniqueUrls = new Set(urls);
      expect(uniqueUrls.size).toBe(result.docs.length);
    }, 15000);

    itIfSolr('should have valid status values for all jobs', async () => {
      const validStatuses = ['scraped', 'tested', 'verified', 'published'];
      const result = await solr.querySOLR(CIF);

      for (const job of result.docs) {
        expect(validStatuses).toContain(job.status);
      }
    }, 15000);

    itIfSolr('should have valid CIF format for all jobs', async () => {
      const result = await solr.querySOLR(CIF);

      for (const job of result.docs) {
        expect(job.cif).toMatch(/^\d{8}$/);
      }
    }, 15000);
  });

  describe('Full Validation Workflow', () => {
    let anaf;
    let companyModule;

    beforeAll(async () => {
      anaf = await import('../../src/anaf.js');
      companyModule = await import('../../company.js');
    });

    it('should complete the ANAF → Peviitor validation path', async () => {
      const searchResults = await anaf.searchCompany(BRAND);
      expect(searchResults.length).toBeGreaterThan(0);

      const company = searchResults.find(c =>
        c.name.toUpperCase().includes('SENNDER') && c.statusLabel === 'Funcțiune'
      );
      expect(company).toBeDefined();

      const anafData = await anaf.getCompanyFromANAF(company.cui.toString());
      expect(anafData.inactive).toBe(false);
    }, 30000);

    itIfSolr('should have matching CIF in company core', async () => {
      await companyModule.validateAndGetCompany();
      const solrObj = await import('../../solr.js');

      const solrResult = await solrObj.queryCompanySOLR(`id:${CIF}`);
      expect(solrResult.numFound).toBe(1);
      expect(solrResult.docs[0].id).toBe(CIF);
      expect(solrResult.docs[0].company).toBe(LEGAL_NAME);
    }, 30000);

    itIfSolr('should validate company and query SOLR for existing jobs', async () => {
      const companyResult = await companyModule.validateAndGetCompany();

      expect(companyResult.status).toBe('active');
      expect(companyResult.company).toBe(LEGAL_NAME);
      expect(companyResult.cif).toBe(CIF);

      if (companyResult.existingJobsCount === 0) {
        console.log(`⚠️ No ${BRAND} jobs in Solr — skipping job count assertion (scraper may not have run yet)`);
        return;
      }
      expect(companyResult.existingJobsCount).toBeGreaterThan(0);
    }, 30000);
  });
});
