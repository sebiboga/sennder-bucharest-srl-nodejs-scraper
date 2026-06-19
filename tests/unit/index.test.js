import { jest } from '@jest/globals';

const mockNodeFetch = jest.fn();
jest.unstable_mockModule('node-fetch', () => ({
  default: mockNodeFetch
}));

let index;

beforeAll(async () => {
  index = await import('../../index.js');
});

beforeEach(() => {
  mockNodeFetch.mockReset();
});

describe('transformJobsForSOLR', () => {
  it('should filter to only Romanian locations splitting by comma', () => {
    const payload = {
      jobs: [
        { url: 'https://test.com/1', title: 'Job 1', location: ['Bucharest, Romania'] },
        { url: 'https://test.com/2', title: 'Job 2', location: ['Bucharest'] },
        { url: 'https://test.com/3', title: 'Job 3', location: ['Berlin, Germany'] },
        { url: 'https://test.com/4', title: 'Job 4', location: ['Cluj-Napoca, Romania'] },
        { url: 'https://test.com/5', title: 'Job 5', location: [] }
      ]
    };

    const result = index.transformJobsForSOLR(payload);

    expect(result.jobs).toHaveLength(3);
    expect(result.jobs[0].location).toEqual(['Bucharest']);
    expect(result.jobs[1].location).toEqual(['Bucharest']);
    expect(result.jobs[2].location).toEqual(['Cluj-Napoca']);
  });

  it('should filter out non-Romanian jobs entirely', () => {
    const payload = {
      jobs: [
        { url: 'https://test.com/1', title: 'Job 1', location: ['Berlin, Germany'] },
        { url: 'https://test.com/2', title: 'Job 2', location: ['Paris'] }
      ]
    };

    const result = index.transformJobsForSOLR(payload);

    expect(result.jobs).toHaveLength(0);
  });

  it('should keep company uppercase', () => {
    const payload = {
      source: 'gem.com',
      company: 'sennder bucharest srl',
      cif: '45780151',
      jobs: [
        { url: 'https://test.com/1', title: 'Job 1', location: ['Bucharest'] }
      ]
    };

    const result = index.transformJobsForSOLR(payload);

    expect(result.company).toBe('SENNDER BUCHAREST SRL');
  });

  it('should normalize workmode values', () => {
    const payload = {
      jobs: [
        { url: 'https://test.com/1', title: 'Job 1', workmode: 'Remote', location: ['Bucharest'] },
        { url: 'https://test.com/2', title: 'Job 2', workmode: 'ON-SITE', location: ['Bucharest'] },
        { url: 'https://test.com/3', title: 'Job 3', workmode: 'Hybrid', location: ['Bucharest'] }
      ]
    };

    const result = index.transformJobsForSOLR(payload);

    expect(result.jobs[0].workmode).toBe('remote');
    expect(result.jobs[1].workmode).toBe('on-site');
    expect(result.jobs[2].workmode).toBe('hybrid');
  });

  it('should handle empty jobs array', () => {
    const result = index.transformJobsForSOLR({ jobs: [] });
    expect(result.jobs).toEqual([]);
  });
});

describe('mapToJobModel', () => {
  it('should map raw job to job model format', () => {
    const rawJob = {
      url: 'https://api.gem.com/job_board/v0/senndertechnologies-gmbh/job_posts/123',
      title: 'Senior Developer',
      location: ['Bucharest'],
      tags: ['engineering'],
      workmode: 'hybrid'
    };

    const COMPANY_NAME = 'SENNDER BUCHAREST SRL';
    const COMPANY_CIF = '45780151';

    const result = index.mapToJobModel(rawJob, COMPANY_CIF, COMPANY_NAME);

    expect(result.url).toBe(rawJob.url);
    expect(result.title).toBe(rawJob.title);
    expect(result.company).toBe(COMPANY_NAME);
    expect(result.cif).toBe(COMPANY_CIF);
    expect(result.location).toEqual(rawJob.location);
    expect(result.tags).toEqual(rawJob.tags);
    expect(result.workmode).toBe(rawJob.workmode);
    expect(result.status).toBe('scraped');
    expect(result.date).toBeDefined();
  });

  it('should remove undefined fields', () => {
    const rawJob = {
      url: 'https://test.com/1',
      title: 'Job 1'
    };

    const result = index.mapToJobModel(rawJob, '45780151');

    expect(result.location).toBeUndefined();
    expect(result.tags).toBeUndefined();
    expect(result.workmode).toBeUndefined();
  });
});

describe('fetchGemJobs', () => {
  it('should parse Gem API response format', async () => {
    const mockData = [
      {
        requisition_id: '123',
        title: 'Senior Developer',
        absolute_url: 'https://jobs.gem.com/senndertechnologies-gmbh/123',
        location: { name: 'Bucharest, Romania' },
        offices: [{ name: 'Bucharest' }],
        departments: [{ name: 'Engineering' }],
        location_type: 'Hybrid'
      }
    ];

    mockNodeFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(mockData)
    });

    const result = await index.fetchGemJobs();

    expect(result).toHaveLength(1);
    expect(result[0].title).toBe('Senior Developer');
    expect(result[0].location).toContain('Bucharest, Romania');
    expect(result[0].workmode).toBe('Hybrid');
    expect(result[0].tags).toContain('engineering');
  });

  it('should keep all posts even with same requisition_id (URL is unique key)', async () => {
    const mockData = [
      { requisition_id: '123', title: 'Job 1', absolute_url: 'https://jobs.gem.com/123', departments: [] },
      { requisition_id: '123', title: 'Job 2', absolute_url: 'https://jobs.gem.com/456', departments: [] }
    ];

    mockNodeFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(mockData)
    });

    const result = await index.fetchGemJobs();

    expect(result).toHaveLength(2);
  });
});
