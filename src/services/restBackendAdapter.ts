import { Adapter, BackendConnection } from '../types';

export class RestBackendAdapter implements Adapter {
  private baseUrl: string;
  private token?: string;

  constructor(private conn: BackendConnection) {
    this.baseUrl = conn.url.replace(/\/$/, '');
    this.token = conn.token;
  }

  private async request(path: string, options: RequestInit = {}): Promise<any> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...(options.headers as Record<string, string> || {})
    };
    if (this.token) headers['Authorization'] = `Bearer ${this.token}`;
    const res = await fetch(`${this.baseUrl}${path}`, { ...options, headers });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`RestBackend request failed: ${res.status} ${text}`);
    }
    return res.json();
  }

  async authenticate(): Promise<void> {
    if (this.token) return;
    if (this.conn.email && this.conn.password) {
      const data = await this.request('/api/auth/login', {
        method: 'POST',
        body: JSON.stringify({ identity: this.conn.email, password: this.conn.password })
      });
      this.token = data.token || data.access_token || data.data?.token;
      if (!this.token) throw new Error('Unable to authenticate: token not found in response');
    } else {
      throw new Error('RestBackend connection requires email/password or token');
    }
  }

  async list(collection: string, query: any = {}) {
    await this.authenticate();
    const qs = new URLSearchParams(query as Record<string, string>).toString();
    return this.request(`/api/collections/${collection}/records${qs ? `?${qs}` : ''}`);
  }

  async create(collection: string, data: any) {
    await this.authenticate();
    return this.request(`/api/collections/${collection}/records`, {
      method: 'POST',
      body: JSON.stringify(data)
    });
  }

  async update(collection: string, id: string, data: any) {
    await this.authenticate();
    return this.request(`/api/collections/${collection}/records/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(data)
    });
  }

  async delete(collection: string, id: string) {
    await this.authenticate();
    return this.request(`/api/collections/${collection}/records/${id}`, {
      method: 'DELETE'
    });
  }

  async getCollections() {
    await this.authenticate();
    return this.request('/api/collections');
  }

  async createCollection(schema: any) {
    await this.authenticate();
    return this.request('/api/collections', {
      method: 'POST',
      body: JSON.stringify(schema)
    });
  }

  async callEdgeFunction(name: string, payload: any) {
    await this.authenticate();
    return this.request(`/api/functions/${name}`, {
      method: 'POST',
      body: JSON.stringify(payload)
    });
  }
}
