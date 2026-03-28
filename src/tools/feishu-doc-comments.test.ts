import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@larksuiteoapi/node-sdk', () => ({
  withUserAccessToken: (token: string) => ({ userAccessToken: token }),
}));

vi.mock('./feishu-oapi.js', () => ({
  assertOk: (res: any) => {
    if (res.code !== 0) throw new Error(res.msg);
  },
}));

const mockClient = {
  wiki: {
    space: {
      getNode: vi.fn(),
    },
  },
  drive: {
    v1: {
      fileComment: {
        list: vi.fn(),
        create: vi.fn(),
        patch: vi.fn(),
      },
      fileCommentReply: {
        list: vi.fn(),
      },
    },
  },
} as any;

const { handleDocComments } = await import('./feishu-doc-comments.js');

describe('handleDocComments', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // -------------------------------------------------------------------------
  // LIST
  // -------------------------------------------------------------------------

  it('list: returns comments without replies', async () => {
    const items = [
      { comment_id: 'c1', reply_list: { replies: [] } },
    ];
    mockClient.drive.v1.fileComment.list.mockResolvedValue({
      code: 0,
      msg: 'success',
      data: { items, has_more: false, page_token: undefined },
    });

    const result: any = await handleDocComments(
      { action: 'list', file_token: 'tok1', file_type: 'docx' },
      'u-token',
      mockClient,
    );

    expect(mockClient.drive.v1.fileComment.list).toHaveBeenCalledWith(
      {
        path: { file_token: 'tok1' },
        params: {
          file_type: 'docx',
          is_whole: undefined,
          is_solved: undefined,
          page_size: 50,
          page_token: undefined,
          user_id_type: 'open_id',
        },
      },
      { userAccessToken: 'u-token' },
    );
    expect(result.items).toHaveLength(1);
    expect(result.has_more).toBe(false);
    expect(mockClient.drive.v1.fileCommentReply.list).not.toHaveBeenCalled();
  });

  it('list with replies: assembles full reply list', async () => {
    const items = [
      {
        comment_id: 'c1',
        reply_list: { replies: [{ reply_id: 'r1' }] },
      },
    ];
    mockClient.drive.v1.fileComment.list.mockResolvedValue({
      code: 0,
      msg: 'success',
      data: { items, has_more: false },
    });
    mockClient.drive.v1.fileCommentReply.list.mockResolvedValueOnce({
      code: 0,
      data: {
        items: [{ reply_id: 'r1' }, { reply_id: 'r2' }],
        has_more: false,
        page_token: undefined,
      },
    });

    const result: any = await handleDocComments(
      { action: 'list', file_token: 'tok1', file_type: 'docx' },
      'u-token',
      mockClient,
    );

    expect(mockClient.drive.v1.fileCommentReply.list).toHaveBeenCalledWith(
      {
        path: { file_token: 'tok1', comment_id: 'c1' },
        params: {
          file_type: 'docx',
          page_token: undefined,
          page_size: 50,
          user_id_type: 'open_id',
        },
      },
      { userAccessToken: 'u-token' },
    );
    expect(result.items[0].reply_list.replies).toHaveLength(2);
  });

  it('list with replies: paginates until has_more is false', async () => {
    const items = [
      { comment_id: 'c1', reply_list: { replies: [{ reply_id: 'r1' }] } },
    ];
    mockClient.drive.v1.fileComment.list.mockResolvedValue({
      code: 0,
      data: { items, has_more: false },
    });
    mockClient.drive.v1.fileCommentReply.list
      .mockResolvedValueOnce({
        code: 0,
        data: { items: [{ reply_id: 'r1' }], has_more: true, page_token: 'pg2' },
      })
      .mockResolvedValueOnce({
        code: 0,
        data: { items: [{ reply_id: 'r2' }], has_more: false },
      });

    const result: any = await handleDocComments(
      { action: 'list', file_token: 'tok1', file_type: 'docx' },
      'u-token',
      mockClient,
    );

    expect(mockClient.drive.v1.fileCommentReply.list).toHaveBeenCalledTimes(2);
    expect(result.items[0].reply_list.replies).toHaveLength(2);
  });

  it('list with wiki token: auto-converts via getNode', async () => {
    mockClient.wiki.space.getNode.mockResolvedValue({
      code: 0,
      data: { node: { obj_token: 'real-tok', obj_type: 'docx' } },
    });
    mockClient.drive.v1.fileComment.list.mockResolvedValue({
      code: 0,
      data: { items: [], has_more: false },
    });

    await handleDocComments(
      { action: 'list', file_token: 'wiki-tok', file_type: 'wiki' },
      'u-token',
      mockClient,
    );

    expect(mockClient.wiki.space.getNode).toHaveBeenCalledWith(
      { params: { token: 'wiki-tok', obj_type: 'wiki' } },
      { userAccessToken: 'u-token' },
    );
    const listCall = mockClient.drive.v1.fileComment.list.mock.calls[0][0];
    expect(listCall.path.file_token).toBe('real-tok');
    expect(listCall.params.file_type).toBe('docx');
  });

  it('list with wiki token: returns error if node has no obj_token', async () => {
    mockClient.wiki.space.getNode.mockResolvedValue({
      code: 0,
      data: { node: { node_token: 'wiki-tok' } },
    });

    const result: any = await handleDocComments(
      { action: 'list', file_token: 'wiki-tok', file_type: 'wiki' },
      'u-token',
      mockClient,
    );

    expect(result.error).toMatch(/failed to resolve wiki token/);
  });

  // -------------------------------------------------------------------------
  // CREATE
  // -------------------------------------------------------------------------

  it('create: converts elements and creates comment', async () => {
    const comment = { comment_id: 'new-c1' };
    mockClient.drive.v1.fileComment.create.mockResolvedValue({
      code: 0,
      data: comment,
    });

    const result: any = await handleDocComments(
      {
        action: 'create',
        file_token: 'tok1',
        file_type: 'docx',
        elements: [
          { type: 'text', text: 'Hello ' },
          { type: 'mention', open_id: 'ou_abc' },
          { type: 'link', url: 'https://example.com' },
        ],
      },
      'u-token',
      mockClient,
    );

    const createCall = mockClient.drive.v1.fileComment.create.mock.calls[0][0];
    expect(createCall.path.file_token).toBe('tok1');
    expect(createCall.params.file_type).toBe('docx');
    const elements = createCall.data.reply_list.replies[0].content.elements;
    expect(elements).toEqual([
      { type: 'text_run', text_run: { text: 'Hello ' } },
      { type: 'person', person: { user_id: 'ou_abc' } },
      { type: 'docs_link', docs_link: { url: 'https://example.com' } },
    ]);
    expect(result.comment_id).toBe('new-c1');
  });

  it('create: returns error when elements is empty', async () => {
    const result: any = await handleDocComments(
      { action: 'create', file_token: 'tok1', file_type: 'docx', elements: [] },
      'u-token',
      mockClient,
    );
    expect(result.error).toMatch(/elements/);
    expect(mockClient.drive.v1.fileComment.create).not.toHaveBeenCalled();
  });

  it('create: returns error when elements is missing', async () => {
    const result: any = await handleDocComments(
      { action: 'create', file_token: 'tok1', file_type: 'docx' },
      'u-token',
      mockClient,
    );
    expect(result.error).toMatch(/elements/);
  });

  // -------------------------------------------------------------------------
  // PATCH
  // -------------------------------------------------------------------------

  it('patch: resolves comment', async () => {
    mockClient.drive.v1.fileComment.patch.mockResolvedValue({
      code: 0,
      data: {},
    });

    const result: any = await handleDocComments(
      {
        action: 'patch',
        file_token: 'tok1',
        file_type: 'docx',
        comment_id: 'c1',
        is_solved_value: true,
      },
      'u-token',
      mockClient,
    );

    expect(mockClient.drive.v1.fileComment.patch).toHaveBeenCalledWith(
      {
        path: { file_token: 'tok1', comment_id: 'c1' },
        params: { file_type: 'docx' },
        data: { is_solved: true },
      },
      { userAccessToken: 'u-token' },
    );
    expect(result.success).toBe(true);
  });

  it('patch: recovers comment (is_solved_value=false)', async () => {
    mockClient.drive.v1.fileComment.patch.mockResolvedValue({
      code: 0,
      data: {},
    });

    const result: any = await handleDocComments(
      {
        action: 'patch',
        file_token: 'tok1',
        file_type: 'docx',
        comment_id: 'c1',
        is_solved_value: false,
      },
      'u-token',
      mockClient,
    );

    const patchCall = mockClient.drive.v1.fileComment.patch.mock.calls[0][0];
    expect(patchCall.data.is_solved).toBe(false);
    expect(result.success).toBe(true);
  });

  it('patch: returns error when comment_id is missing', async () => {
    const result: any = await handleDocComments(
      { action: 'patch', file_token: 'tok1', file_type: 'docx', is_solved_value: true },
      'u-token',
      mockClient,
    );
    expect(result.error).toMatch(/comment_id/);
  });

  it('patch: returns error when is_solved_value is missing', async () => {
    const result: any = await handleDocComments(
      { action: 'patch', file_token: 'tok1', file_type: 'docx', comment_id: 'c1' },
      'u-token',
      mockClient,
    );
    expect(result.error).toMatch(/is_solved_value/);
  });

  // -------------------------------------------------------------------------
  // Element conversion edge cases
  // -------------------------------------------------------------------------

  it('element conversion: handles unknown type gracefully', async () => {
    mockClient.drive.v1.fileComment.create.mockResolvedValue({
      code: 0,
      data: { comment_id: 'c-x' },
    });

    await handleDocComments(
      {
        action: 'create',
        file_token: 'tok1',
        file_type: 'docx',
        elements: [{ type: 'text' as any, text: 'hello' }],
      },
      'u-token',
      mockClient,
    );

    const createCall = mockClient.drive.v1.fileComment.create.mock.calls[0][0];
    const elements = createCall.data.reply_list.replies[0].content.elements;
    expect(elements[0].type).toBe('text_run');
  });

  // -------------------------------------------------------------------------
  // API error propagation
  // -------------------------------------------------------------------------

  it('throws on API error for list', async () => {
    mockClient.drive.v1.fileComment.list.mockResolvedValue({
      code: 99991400,
      msg: 'Permission denied',
    });

    await expect(
      handleDocComments(
        { action: 'list', file_token: 'tok1', file_type: 'docx' },
        'u-token',
        mockClient,
      ),
    ).rejects.toThrow('Permission denied');
  });

  it('throws on API error for wiki token resolution', async () => {
    mockClient.wiki.space.getNode.mockResolvedValue({
      code: 403,
      msg: 'Forbidden',
    });

    await expect(
      handleDocComments(
        { action: 'list', file_token: 'wiki-tok', file_type: 'wiki' },
        'u-token',
        mockClient,
      ),
    ).rejects.toThrow('Forbidden');
  });
});
