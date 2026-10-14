import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const emptyState = () => ({ version: 1, users: [], records: [] });

export class JsonStore {
  constructor(file) {
    this.file = file;
    this.queue = Promise.resolve();
  }

  async read() {
    try {
      const data = JSON.parse(await readFile(this.file, 'utf8'));
      if (data?.version !== 1 || !Array.isArray(data.users) || !Array.isArray(data.records)) {
        throw new Error('数据文件格式不受支持');
      }
      return data;
    } catch (error) {
      if (error.code === 'ENOENT') return emptyState();
      throw error;
    }
  }

  update(change) {
    const job = this.queue.then(async () => {
      const state = await this.read();
      const result = await change(state);
      await mkdir(path.dirname(this.file), { recursive: true });
      const temp = `${this.file}.${randomUUID()}.tmp`;
      await writeFile(temp, JSON.stringify(state, null, 2), { encoding: 'utf8', flag: 'wx' });
      await rename(temp, this.file);
      return result;
    });
    this.queue = job.catch(() => {});
    return job;
  }
}
