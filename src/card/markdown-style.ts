/**
 * Markdown style optimization for Feishu cards.
 * Ported from @larksuite/openclaw-lark.
 *
 * - Heading demotion: H1 → H4, H2~H6 → H5 (Feishu renders H1/H2 too large)
 * - Table spacing with <br> padding
 * - Code block protection with placeholder extraction
 * - Consecutive heading spacing
 * - Strip invalid image keys (non img_xxx references)
 */

const IMAGE_RE = /!\[([^\]]*)\]\(([^)\s]+)\)/g;

function stripInvalidImageKeys(text: string): string {
  if (!text.includes('![')) return text;
  return text.replace(IMAGE_RE, (fullMatch, _alt, value) => {
    if (value.startsWith('img_')) return fullMatch;
    return '';
  });
}

export function optimizeMarkdownStyle(text: string): string {
  try {
    let r = _optimize(text);
    r = stripInvalidImageKeys(r);
    return r;
  } catch {
    return text;
  }
}

function _optimize(text: string): string {
  const MARK = '___CB_';
  const codeBlocks: string[] = [];
  let r = text.replace(/```[\s\S]*?```/g, (m) => `${MARK}${codeBlocks.push(m) - 1}___`);

  // Heading demotion (only if H1~H3 exist)
  if (/^#{1,3} /m.test(text)) {
    r = r.replace(/^#{2,6} (.+)$/gm, '##### $1');
    r = r.replace(/^# (.+)$/gm, '#### $1');
  }

  // Consecutive headings spacing
  r = r.replace(/^(#{4,5} .+)\n{1,2}(#{4,5} )/gm, '$1\n<br>\n$2');

  // Table spacing
  r = r.replace(/^([^|\n].*)\n(\|.+\|)/gm, '$1\n\n$2');
  r = r.replace(/\n\n((?:\|.+\|[^\S\n]*\n?)+)/g, '\n\n<br>\n\n$1');
  r = r.replace(/((?:^\|.+\|[^\S\n]*\n?)+)/gm, '$1\n<br>\n');
  r = r.replace(/^((?!#{4,5} )(?!\*\*).+)\n\n(<br>)\n\n(\|)/gm, '$1\n$2\n$3');
  r = r.replace(/^(\*\*.+)\n\n(<br>)\n\n(\|)/gm, '$1\n$2\n\n$3');
  r = r.replace(/(\|[^\n]*\n)\n(<br>\n)((?!#{4,5} )(?!\*\*))/gm, '$1$2$3');

  // Restore code blocks with <br> padding
  codeBlocks.forEach((block, i) => {
    r = r.replace(`${MARK}${i}___`, `\n<br>\n${block}\n<br>\n`);
  });

  // Compress excess blank lines
  r = r.replace(/\n{3,}/g, '\n\n');
  return r;
}
