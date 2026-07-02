/**
 * The two extension seams of infront (see docs/driver-spec.md).
 *
 * Drivers own TRANSPORT and STORAGE mechanics; the engine owns all POLICY
 * (pooling, leases, hygiene, upkeep, sync, error taxonomy). A driver that
 * wants policy is a design bug.
 */

export interface ExecOptions {
  cwd?: string;
  env?: Record<string, string>;
  /** Remote substrates must support detached (submit-and-poll) execution. */
  detach?: boolean;
  timeoutMs?: number;
}

export interface ExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  /** Set when detach:true — poll/reattach handle, journaled on the box. */
  jobId?: string;
}

export interface EnvHandle {
  id: string;
  /** Filesystem root of the environment's tree (local path or remote path). */
  root: string;
  substrate: string;
}

export interface SubstrateCapabilities {
  pause: boolean;
  checkpoint: boolean;
}

export interface SubstrateDriver {
  readonly name: string;
  readonly capabilities: SubstrateCapabilities;

  /** Idempotent per env id. */
  provision(envId: string): Promise<EnvHandle>;
  exec(env: EnvHandle, cmd: string[], opts?: ExecOptions): Promise<ExecResult>;
  /** A git remote/path the sync layer can fetch/push through. */
  gitEndpoint(env: EnvHandle): Promise<string>;
  /** Consumer-reachable URL for a port inside the environment. */
  expose(env: EnvHandle, port: number): Promise<string>;
  destroy(env: EnvHandle): Promise<void>;

  pause?(env: EnvHandle): Promise<void>;
  resume?(env: EnvHandle): Promise<void>;
  checkpoint?(env: EnvHandle, key: string): Promise<void>;
  restore?(key: string, envId: string): Promise<EnvHandle>;

  /** Adopt-or-reap discovery of instances the local journal forgot (remote). */
  reconcile?(): Promise<EnvHandle[]>;
}

export interface DatastoreCapabilities {
  template: boolean;
  /** Reset-data degenerates to flush; presets are meaningless. */
  ephemeral: boolean;
}

export interface DatastoreDriver {
  readonly name: string;
  readonly capabilities: DatastoreCapabilities;

  /** infra-error (never code blame) when the external server is unreachable. */
  probe(): Promise<void>;
  create(ns: string, preset: string): Promise<void>;
  /** Must refuse namespaces outside infront's own pattern. */
  drop(ns: string): Promise<void>;
  url(ns: string): string;

  templateBake?(preset: string, seedHash: string): Promise<void>;
  templateRestore?(ns: string, preset: string, seedHash: string): Promise<void>;
}
