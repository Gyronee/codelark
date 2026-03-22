import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./feishu-oapi.js', () => ({
  callFeishuOapi: vi.fn(),
  assertOk: (res: any) => { if (res.code !== 0) throw new Error(res.msg); },
}));

const { callFeishuOapi } = await import('./feishu-oapi.js');
const mockCallOapi = vi.mocked(callFeishuOapi);

const { handleSearch } = await import('./feishu-search.js');

describe('handleSearch', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('calls search API with query and empty filters by default', async () => {
    mockCallOapi.mockResolvedValue({
      code: 0, msg: 'success',
      data: { res_units: [{ title: 'Test Doc' }], total: 1, has_more: false },
    });

    const result = await handleSearch({ query: 'test' }, 'u-token');

    expect(mockCallOapi).toHaveBeenCalledWith(expect.objectContaining({
      method: 'POST',
      path: '/open-apis/search/v2/doc_wiki/search',
      userAccessToken: 'u-token',
    }));
    const body = mockCallOapi.mock.calls[0][0].body!;
    expect(body.query).toBe('test');
    expect(body.doc_filter).toEqual({});
    expect(body.wiki_filter).toEqual({});
    expect(result.total).toBe(1);
    expect(result.results).toHaveLength(1);
  });

  it('applies filter to both doc_filter and wiki_filter', async () => {
    mockCallOapi.mockResolvedValue({
      code: 0, msg: 'success',
      data: { res_units: [], total: 0, has_more: false },
    });

    await handleSearch({
      query: 'design',
      filter: { doc_types: ['DOCX', 'WIKI'], only_title: true },
    }, 'u-token');

    const body = mockCallOapi.mock.calls[0][0].body!;
    expect(body.doc_filter).toEqual({ doc_types: ['DOCX', 'WIKI'], only_title: true });
    expect(body.wiki_filter).toEqual({ doc_types: ['DOCX', 'WIKI'], only_title: true });
  });

  it('supports empty query for browse-style search', async () => {
    mockCallOapi.mockResolvedValue({
      code: 0, msg: 'success',
      data: { res_units: [], total: 0, has_more: false },
    });

    await handleSearch({}, 'u-token');
    expect(mockCallOapi.mock.calls[0][0].body!.query).toBe('');
  });

  it('converts time ranges to unix timestamps', async () => {
    mockCallOapi.mockResolvedValue({
      code: 0, msg: 'success',
      data: { res_units: [], total: 0, has_more: false },
    });

    await handleSearch({
      query: 'test',
      filter: {
        open_time: { start: '2024-01-01T00:00:00+08:00' },
        create_time: { end: '2024-12-31T23:59:59+08:00' },
      },
    }, 'u-token');

    const body = mockCallOapi.mock.calls[0][0].body!;
    const docFilter = body.doc_filter as any;
    expect(typeof docFilter.open_time.start).toBe('string');
    expect(Number(docFilter.open_time.start)).toBeGreaterThan(1e9);
  });

  it('normalizes unix timestamps in results to ISO 8601', async () => {
    mockCallOapi.mockResolvedValue({
      code: 0, msg: 'success',
      data: {
        res_units: [{ title: 'Doc', create_time: '1704067200', edit_time: '1704153600' }],
        total: 1,
        has_more: false,
      },
    });

    const result = await handleSearch({ query: 'test' }, 'u-token');
    const doc = result.results[0] as any;
    expect(doc.create_time).toContain('2024-');
    expect(doc.edit_time).toContain('2024-');
  });

  it('passes pagination params', async () => {
    mockCallOapi.mockResolvedValue({
      code: 0, msg: 'success',
      data: { res_units: [], total: 0, has_more: true, page_token: 'next-page' },
    });

    const result = await handleSearch({ query: 'test', page_size: 5, page_token: 'abc' }, 'u-token');
    const body = mockCallOapi.mock.calls[0][0].body!;
    expect(body.page_size).toBe(5);
    expect(body.page_token).toBe('abc');
    expect(result.has_more).toBe(true);
    expect(result.page_token).toBe('next-page');
  });
});
