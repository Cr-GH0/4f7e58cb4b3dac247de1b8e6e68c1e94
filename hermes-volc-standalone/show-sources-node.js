import { readFile, writeFile, rename } from 'node:fs/promises';

// Save HTML and speaking instructions together. Source files remain the default.
export function fileShowSources({ path, htmlPath, promptPath }) {
  let queue = Promise.resolve();
  const current = async () => {
    const [html, prompt] = await Promise.all([readFile(htmlPath, 'utf8'), readFile(promptPath, 'utf8')]);
    try {
      const saved = JSON.parse(await readFile(path, 'utf8'));
      return { ...saved, customHtml: saved.html !== html };
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      return { html, prompt, revision: 0, customHtml: false };
    }
  };
  return {
    current,
    save(input) {
      const work = queue.catch(() => {}).then(async () => {
        if (typeof input.html !== 'string' || !input.html.trim()) throw new Error('请填写或导入 HTML 产物。');
        if (typeof input.prompt !== 'string' || !input.prompt.trim()) throw new Error('请填写 Hermes 提示词。');
        if (Buffer.byteLength(input.html, 'utf8') > 5 * 1024 * 1024) throw new Error('HTML 文件需小于 5 MB。');
        if (input.prompt.length > 40000) throw new Error('提示词需少于 40,000 个字符。');
        const before = await current();
        const saved = { html: input.html, prompt: input.prompt, revision: before.revision + 1, updatedAt: new Date().toISOString() };
        await writeFile(path + '.tmp', JSON.stringify(saved), 'utf8');
        await rename(path + '.tmp', path);
        return current();
      });
      queue = work;
      return work;
    },
  };
}
