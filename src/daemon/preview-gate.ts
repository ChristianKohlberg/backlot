import { createServer, connect, type Socket } from 'node:net';

/** Public tunnels use this origin, never a service port directly. Expiry closes
 * existing streams as well as the listener, even if tunnel teardown fails. */
export class PreviewGate {
  private server = createServer({ allowHalfOpen: true }, client => {
    if (Date.now() >= this.expiresAt || this.sockets.size >= 1024) { client.destroy(); return; }
    const upstream = connect({ port: this.port, host: 'localhost', allowHalfOpen: true });
    this.sockets.add(client);
    this.sockets.add(upstream);
    const close = () => {
      client.destroy(); upstream.destroy();
      this.sockets.delete(client); this.sockets.delete(upstream);
    };
    client.on('error', close); upstream.on('error', close);
    client.on('close', close); upstream.on('close', close);
    const forward = (from: Socket, to: Socket) => {
      from.on('data', chunk => {
        // Wall-clock expiry also applies immediately after suspend/resume,
        // before a delayed timer has had a chance to run.
        if (Date.now() >= this.expiresAt) { this.close(); return; }
        if (!to.write(chunk)) from.pause();
      });
      to.on('drain', () => from.resume());
      from.on('end', () => to.end());
    };
    forward(client, upstream);
    forward(upstream, client);
  });
  private sockets = new Set<Socket>();
  private timer?: NodeJS.Timeout;
  pid?: number;
  private constructor(private port: number, public expiresAt: number) {}

  static async open(port: number, expiresAt: number): Promise<PreviewGate> {
    const gate = new PreviewGate(port, expiresAt);
    await new Promise<void>((resolve, reject) => {
      gate.server.once('error', reject);
      gate.server.listen(0, 'localhost', () => { gate.server.off('error', reject); resolve(); });
    });
    gate.arm();
    return gate;
  }
  /** Extend only a still-live origin; renewal never reopens expired access. */
  renew(expiresAt: number): boolean {
    if (!this.server.listening || Date.now() >= this.expiresAt || !Number.isFinite(expiresAt) || expiresAt <= Date.now()) return false;
    this.expiresAt = expiresAt;
    this.arm();
    return true;
  }
  private arm(): void {
    clearTimeout(this.timer);
    const remaining = this.expiresAt - Date.now();
    if (remaining <= 0) { this.close(); return; }
    this.timer = setTimeout(() => this.arm(), Math.min(remaining, 2_147_483_647));
    this.timer.unref();
  }
  get url(): string {
    const address = this.server.address();
    if (!address || typeof address === 'string') throw new Error('preview deadline elapsed before publishing');
    return `http://localhost:${address.port}`;
  }
  close(): void {
    clearTimeout(this.timer);
    this.server.close();
    for (const socket of this.sockets) socket.destroy();
    this.sockets.clear();
  }
}
