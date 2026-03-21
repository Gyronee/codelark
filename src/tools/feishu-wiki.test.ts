import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./feishu-oapi.js', () => ({
  assertOk: (res: any) => { if (res.code !== 0) throw new Error(res.msg); },
}));

// Create mock client
const mockClient = {
  wiki: {
    space: {
      list: vi.fn(),
      get: vi.fn(),
      create: vi.fn(),
      getNode: vi.fn(),
    },
    spaceNode: {
      list: vi.fn(),
      create: vi.fn(),
      move: vi.fn(),
      copy: vi.fn(),
    },
  },
} as any;

const { handleWikiSpace, handleWikiSpaceNode } = await import('./feishu-wiki.js');

describe('handleWikiSpace', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('list: returns spaces with pagination', async () => {
    const items = [{ space_id: 's1', name: 'Space One' }];
    mockClient.wiki.space.list.mockResolvedValue({
      code: 0,
      msg: 'success',
      data: { items, has_more: true, page_token: 'next' },
    });

    const result = await handleWikiSpace(
      { action: 'list', page_size: 10 },
      'u-token',
      mockClient,
    );

    expect(mockClient.wiki.space.list).toHaveBeenCalledWith(
      { params: { page_size: 10, page_token: undefined } },
      { userAccessToken: 'u-token' },
    );
    expect(result.spaces).toEqual(items);
    expect(result.has_more).toBe(true);
    expect(result.page_token).toBe('next');
  });

  it('list: passes page_token for subsequent pages', async () => {
    mockClient.wiki.space.list.mockResolvedValue({
      code: 0, msg: 'success',
      data: { items: [], has_more: false },
    });

    await handleWikiSpace(
      { action: 'list', page_token: 'abc' },
      'u-token',
      mockClient,
    );

    const call = mockClient.wiki.space.list.mock.calls[0][0];
    expect(call.params.page_token).toBe('abc');
  });

  it('get: returns space details', async () => {
    const space = { space_id: 's1', name: 'My Space' };
    mockClient.wiki.space.get.mockResolvedValue({
      code: 0, msg: 'success',
      data: { space },
    });

    const result = await handleWikiSpace(
      { action: 'get', space_id: 's1' },
      'u-token',
      mockClient,
    );

    expect(mockClient.wiki.space.get).toHaveBeenCalledWith(
      { path: { space_id: 's1' } },
      { userAccessToken: 'u-token' },
    );
    expect(result.space).toEqual(space);
  });

  it('get: throws when space_id is missing', async () => {
    await expect(
      handleWikiSpace({ action: 'get' }, 'u-token', mockClient),
    ).rejects.toThrow('space_id is required');
  });

  it('create: creates and returns new space', async () => {
    const space = { space_id: 'new-s', name: 'New Space' };
    mockClient.wiki.space.create.mockResolvedValue({
      code: 0, msg: 'success',
      data: { space },
    });

    const result = await handleWikiSpace(
      { action: 'create', name: 'New Space', description: 'A description' },
      'u-token',
      mockClient,
    );

    expect(mockClient.wiki.space.create).toHaveBeenCalledWith(
      { data: { name: 'New Space', description: 'A description' } },
      { userAccessToken: 'u-token' },
    );
    expect(result.space).toEqual(space);
  });

  it('throws on API error', async () => {
    mockClient.wiki.space.list.mockResolvedValue({ code: 99991400, msg: 'Permission denied' });

    await expect(
      handleWikiSpace({ action: 'list' }, 'u-token', mockClient),
    ).rejects.toThrow('Permission denied');
  });
});

describe('handleWikiSpaceNode', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('list: returns nodes with pagination', async () => {
    const items = [{ node_token: 'n1', title: 'Doc One' }];
    mockClient.wiki.spaceNode.list.mockResolvedValue({
      code: 0, msg: 'success',
      data: { items, has_more: false, page_token: undefined },
    });

    const result = await handleWikiSpaceNode(
      { action: 'list', space_id: 's1', page_size: 20 },
      'u-token',
      mockClient,
    );

    expect(mockClient.wiki.spaceNode.list).toHaveBeenCalledWith(
      {
        path: { space_id: 's1' },
        params: { page_size: 20, page_token: undefined, parent_node_token: undefined },
      },
      { userAccessToken: 'u-token' },
    );
    expect(result.nodes).toEqual(items);
    expect(result.has_more).toBe(false);
  });

  it('list: passes parent_node_token', async () => {
    mockClient.wiki.spaceNode.list.mockResolvedValue({
      code: 0, msg: 'success',
      data: { items: [] },
    });

    await handleWikiSpaceNode(
      { action: 'list', space_id: 's1', parent_node_token: 'pnt1' },
      'u-token',
      mockClient,
    );

    const call = mockClient.wiki.spaceNode.list.mock.calls[0][0];
    expect(call.params.parent_node_token).toBe('pnt1');
  });

  it('list: throws when space_id is missing', async () => {
    await expect(
      handleWikiSpaceNode({ action: 'list' }, 'u-token', mockClient),
    ).rejects.toThrow('space_id is required');
  });

  it('get: returns node details using getNode', async () => {
    const node = { node_token: 'n1', obj_token: 'doc-xxx', obj_type: 'wiki' };
    mockClient.wiki.space.getNode.mockResolvedValue({
      code: 0, msg: 'success',
      data: { node },
    });

    const result = await handleWikiSpaceNode(
      { action: 'get', token: 'n1' },
      'u-token',
      mockClient,
    );

    expect(mockClient.wiki.space.getNode).toHaveBeenCalledWith(
      { params: { token: 'n1', obj_type: 'wiki' } },
      { userAccessToken: 'u-token' },
    );
    expect(result.node).toEqual(node);
  });

  it('get: uses custom obj_type when provided', async () => {
    mockClient.wiki.space.getNode.mockResolvedValue({
      code: 0, msg: 'success',
      data: { node: { node_token: 'n1' } },
    });

    await handleWikiSpaceNode(
      { action: 'get', token: 'n1', obj_type: 'docx' },
      'u-token',
      mockClient,
    );

    const call = mockClient.wiki.space.getNode.mock.calls[0][0];
    expect(call.params.obj_type).toBe('docx');
  });

  it('get: throws when token is missing', async () => {
    await expect(
      handleWikiSpaceNode({ action: 'get' }, 'u-token', mockClient),
    ).rejects.toThrow('token is required');
  });

  it('create: creates and returns new node', async () => {
    const node = { node_token: 'new-n', obj_type: 'docx', title: 'My Doc' };
    mockClient.wiki.spaceNode.create.mockResolvedValue({
      code: 0, msg: 'success',
      data: { node },
    });

    const result = await handleWikiSpaceNode(
      {
        action: 'create',
        space_id: 's1',
        obj_type: 'docx',
        title: 'My Doc',
        parent_node_token: 'parent-n',
      },
      'u-token',
      mockClient,
    );

    expect(mockClient.wiki.spaceNode.create).toHaveBeenCalledWith(
      {
        path: { space_id: 's1' },
        data: {
          obj_type: 'docx',
          parent_node_token: 'parent-n',
          node_type: undefined,
          origin_node_token: undefined,
          title: 'My Doc',
        },
      },
      { userAccessToken: 'u-token' },
    );
    expect(result.node).toEqual(node);
  });

  it('create: throws when space_id is missing', async () => {
    await expect(
      handleWikiSpaceNode({ action: 'create', obj_type: 'docx' }, 'u-token', mockClient),
    ).rejects.toThrow('space_id is required');
  });

  it('move: moves node to target parent', async () => {
    const node = { node_token: 'n1' };
    mockClient.wiki.spaceNode.move.mockResolvedValue({
      code: 0, msg: 'success',
      data: { node },
    });

    const result = await handleWikiSpaceNode(
      {
        action: 'move',
        space_id: 's1',
        node_token: 'n1',
        target_parent_token: 'tp1',
      },
      'u-token',
      mockClient,
    );

    expect(mockClient.wiki.spaceNode.move).toHaveBeenCalledWith(
      {
        path: { space_id: 's1', node_token: 'n1' },
        data: { target_parent_token: 'tp1' },
      },
      { userAccessToken: 'u-token' },
    );
    expect(result.node).toEqual(node);
  });

  it('move: throws when space_id or node_token is missing', async () => {
    await expect(
      handleWikiSpaceNode({ action: 'move', node_token: 'n1' }, 'u-token', mockClient),
    ).rejects.toThrow('space_id is required');

    await expect(
      handleWikiSpaceNode({ action: 'move', space_id: 's1' }, 'u-token', mockClient),
    ).rejects.toThrow('node_token is required');
  });

  it('copy: copies node to target space/parent', async () => {
    const node = { node_token: 'copy-n1' };
    mockClient.wiki.spaceNode.copy.mockResolvedValue({
      code: 0, msg: 'success',
      data: { node },
    });

    const result = await handleWikiSpaceNode(
      {
        action: 'copy',
        space_id: 's1',
        node_token: 'n1',
        target_space_id: 's2',
        target_parent_token: 'tp2',
        title: 'Copy of Doc',
      },
      'u-token',
      mockClient,
    );

    expect(mockClient.wiki.spaceNode.copy).toHaveBeenCalledWith(
      {
        path: { space_id: 's1', node_token: 'n1' },
        data: { target_space_id: 's2', target_parent_token: 'tp2', title: 'Copy of Doc' },
      },
      { userAccessToken: 'u-token' },
    );
    expect(result.node).toEqual(node);
  });

  it('copy: throws when space_id or node_token is missing', async () => {
    await expect(
      handleWikiSpaceNode({ action: 'copy', node_token: 'n1' }, 'u-token', mockClient),
    ).rejects.toThrow('space_id is required');

    await expect(
      handleWikiSpaceNode({ action: 'copy', space_id: 's1' }, 'u-token', mockClient),
    ).rejects.toThrow('node_token is required');
  });

  it('throws on API error', async () => {
    mockClient.wiki.spaceNode.list.mockResolvedValue({
      code: 99991400, msg: 'Permission denied',
    });

    await expect(
      handleWikiSpaceNode({ action: 'list', space_id: 's1' }, 'u-token', mockClient),
    ).rejects.toThrow('Permission denied');
  });
});
