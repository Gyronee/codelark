export function buildOAuthCard(authUrl: string, userCode: string) {
  return {
    header: { title: { tag: 'plain_text', content: '🔑 飞书账号授权' }, template: 'blue' },
    elements: [
      { tag: 'markdown', content: `需要授权才能访问飞书文档。\n\n点击下方按钮完成授权，授权码: **${userCode}**` },
      { tag: 'action', actions: [
        { tag: 'button', text: { tag: 'plain_text', content: '前往授权' }, type: 'primary',
          multi_url: { url: authUrl, pc_url: authUrl, android_url: authUrl, ios_url: authUrl } },
      ] },
      { tag: 'markdown', content: '授权完成后将自动继续操作。', text_size: 'notation' },
    ],
  };
}

export function buildOAuthSuccessCard() {
  return {
    elements: [{ tag: 'markdown', content: '✓ 飞书授权成功', text_size: 'notation' }],
  };
}

export function buildOAuthFailedCard(reason: string) {
  return {
    elements: [{ tag: 'markdown', content: `✗ 授权失败: ${reason}`, text_size: 'notation' }],
  };
}
