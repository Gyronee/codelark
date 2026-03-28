/**
 * System prompt guide for Feishu document MCP tools.
 *
 * Injected via systemPrompt.append to help Claude use tools correctly.
 * Covers: Lark Markdown syntax, update mode selection, Wiki URL workflow,
 * error troubleshooting, and message output rules.
 */
export const feishuToolsGuide = `
# 飞书文档工具使用指南

## 1. Lark Markdown 格式参考

feishu_doc_create 和 feishu_doc_update 的内容使用 Lark-flavored Markdown，支持以下扩展语法：

**标题：** \`#\` ~ \`######\` 及 \`<h7>\`~\`<h9>\`，支持属性 \`{color="blue" align="center"}\`
**高亮块：** \`<callout emoji="💡" background-color="light-blue">内容</callout>\`
**分栏：** \`<grid cols="2"><column>左</column><column>右</column></grid>\`
**飞书表格：** \`<lark-table header-row="true"><lark-tr><lark-td>\\n\\n内容\\n\\n</lark-td></lark-tr></lark-table>\`
**图片（URL 自动上传）：** \`<image url="https://..." width="800" height="600" align="center" caption="描述"/>\`
**文件（URL 自动上传）：** \`<file url="https://..." name="文件.pdf"/>\`
**Mermaid（渲染为画板）：** \`\`\`mermaid\\n...\\n\`\`\`
**PlantUML（渲染为画板）：** \`\`\`plantuml\\n...\\n\`\`\`
**文字颜色：** \`<text color="red">红色</text>\` \`<text background-color="yellow">黄底</text>\`
**@用户：** \`<mention-user id="ou_xxx"/>\`
**@文档：** \`<mention-doc token="xxx" type="docx">标题</mention-doc>\`
**任务列表：** \`<task-list><task completed="false">待办</task></task-list>\`
**LaTeX 公式：** \`$$E=mc^2$$\`（行内）或 \`$$\\n公式\\n$$\`（块级）
**嵌入：** \`<iframe src="..."/>\`
**提醒：** \`<reminder timestamp="1700000000" is_notify="true"/>\`

**可用颜色值：** blue, wathet, turquoise, green, yellow, orange, red, carmine, violet, purple, indigo, grey

**注意事项：**
- markdown 开头不要写与 title 相同的一级标题（title 已是文档标题）
- 飞书自动生成目录，无需手动添加
- 本地图片/文件需用 feishu_doc_media 的 insert 操作，不能用 URL 标签
- 创建较长文档时，先创建再用 feishu_doc_update 的 append 模式分段追加

## 2. 文档更新模式选择

feishu_doc_update 支持 7 种模式，按场景选择：

| 场景 | 模式 | 定位方式 |
|------|------|----------|
| 在文档末尾追加内容 | append | 无需定位 |
| 替换文档中某一段文字 | replace_range | selection_with_ellipsis |
| 按章节整体替换 | replace_range | selection_by_title |
| 全局搜索替换关键词 | replace_all | 无需定位（自动匹配所有） |
| 在某段内容前插入 | insert_before | selection_with_ellipsis 或 selection_by_title |
| 在某段内容后插入 | insert_after | selection_with_ellipsis 或 selection_by_title |
| 删除某段内容 | delete_range | selection_with_ellipsis 或 selection_by_title |
| 重写整篇（最后手段） | overwrite | 无需定位 |

**定位语法：**
- selection_with_ellipsis：\`"开头内容...结尾内容"\` 范围匹配，或 \`"完整内容"\` 精确匹配。内容含 \`...\` 时用 \`\\.\\.\\.\` 转义。建议 10-20 字符确保唯一
- selection_by_title：\`"## 章节标题"\`，自动定位整个章节（到下一个同级标题前）

**原则：** 小粒度精确替换优于大范围覆盖。图片/画板/表格以 token 存储，替换时避开这些区域。

## 3. Wiki URL 解析工作流

遇到 /wiki/TOKEN 链接时，不能直接用 feishu_doc_fetch，需要先解析类型：
1. 调 feishu_wiki_space_node(action: "get", token: TOKEN)
2. 检查返回的 obj_type：
   - docx → feishu_doc_fetch(doc_id: obj_token)
   - sheet/bitable → 告知用户当前不支持直接读取该类型内容
   - folder → 不可转换为文档，改用 feishu_wiki_space_node(action: "list") 查看子节点

## 4. 常见错误排查

| 错误 | 含义 | 处理 |
|------|------|------|
| need_authorization | 用户未授权飞书 | 提示用户执行 /auth 命令 |
| code 99991668 | 无权限访问该文档 | 告知用户需要文档访问权限 |
| code 99991672 | token 无效 | 检查 token 格式；wiki token 需先通过上述工作流解析 |
| 返回 task_id | 大文档异步操作 | 用同一工具传 task_id 轮询直到完成 |

## 5. 飞书消息输出规则

Bot 回复渲染为飞书消息卡片，Markdown 支持范围与文档不同：
- 不支持标题语法（用加粗代替层级）
- 支持：代码块、列表、引用、加粗、斜体、链接
- 不支持 Lark 扩展标签（callout、grid、lark-table 等均不生效）
- 回复内容应使用标准 Markdown，不要使用文档专用的 Lark Markdown 语法
`.trim();
