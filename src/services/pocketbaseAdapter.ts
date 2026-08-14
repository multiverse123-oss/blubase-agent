import PocketBase from 'pocketbase';
import { Adapter, BackendConnection } from '../types';

export class PocketBaseAdapter implements Adapter {
  private pb: PocketBase;

  constructor(private conn: BackendConnection) {
    this.pb = new PocketBase(conn.url);
    this.pb.autoCancellation(false);
  }

  async authenticate(): Promise<void> {
    if (this.pb.authStore.isValid) return;
    if (this.conn.token) {
      this.pb.authStore.save(this.conn.token, null);
      return;
    }
    if (!this.conn.email || !this.conn.password) {
      throw new Error('PocketBase connection requires email/password or token');
    }
    try {
      await this.pb.collection('_superusers').authWithPassword(this.conn.email, this.conn.password);
    } catch (err) {
      // Fallback for older PocketBase versions
      // @ts-ignore
      await this.pb.admins.authWithPassword(this.conn.email, this.conn.password);
    }
  }

  async list(collection: string, query: any = {}) {
    await this.authenticate();
    const page = query.page || 1;
    const perPage = query.perPage || 30;
    const filter = query.filter || '';
    const sort = query.sort || '';
    return this.pb.collection(collection).getList(page, perPage, { filter, sort });
  }

  async create(collection: string, data: any) {
    await this.authenticate();
    return this.pb.collection(collection).create(data);
  }

  async update(collection: string, id: string, data: any) {
    await this.authenticate();
    return this.pb.collection(collection).update(id, data);
  }

  async delete(collection: string, id: string) {
    await this.authenticate();
    return this.pb.collection(collection).delete(id);
  }

  async getCollections() {
    await this.authenticate();
    return this.pb.collections.getFullList();
  }

  async createCollection(schema: any) {
    await this.authenticate();
    return this.pb.collections.create(schema);
  }

  async callEdgeFunction(name: string, payload: any) {
    await this.authenticate();
    return this.pb.send(`/api/functions/${name}`, {
      method: 'POST',
      body: payload,
      headers: { 'Content-Type': 'application/json' }
    });
  }
}
