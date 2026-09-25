export type Role = "admin" | "operator" | "viewer";

export const ROLE_LEVEL: Record<Role, number> = { admin: 3, operator: 2, viewer: 1 };

export interface User {
  id: string;
  username: string;
  role: Role;
}

export interface ContainerSummary {
  Id: string;
  Names: string[];
  Image: string;
  ImageID?: string;
  State: string;
  Status: string;
  Created: number;
  Ports: { PrivatePort: number; PublicPort?: number; Type: string; IP?: string }[];
  Mounts: { Source: string; Destination: string; Mode?: string; Type?: string; Name?: string }[];
  Command: string;
  NetworkSettings?: { Networks: Record<string, { IPAddress: string }> };
  Labels?: Record<string, string>;
}

export interface ImageSummary {
  Id: string;
  RepoTags: string[];
  RepoDigests?: string[];
  Size: number;
  Created: number;
  UsedBy?: { Id: string; Name: string }[];
}

export interface NetworkSummary {
  Id: string;
  Name: string;
  Driver: string;
  Scope: string;
  Created?: string;
  Internal?: boolean;
  Attachable?: boolean;
  EnableIPv6?: boolean;
  IPAM?: { Config?: { Subnet?: string; Gateway?: string }[] };
  Labels?: Record<string, string>;
  UsedBy?: { Id: string; Name: string }[];
}

export interface VolumeSummary {
  Name: string;
  Driver: string;
  Mountpoint: string;
  Scope?: string;
  CreatedAt?: string;
  Labels?: Record<string, string>;
  UsedBy?: { Id: string; Name: string }[];
}

export interface ComposeProject {
  id: string;
  name: string;
  base_dir: string;
  compose_file: string;
  env_file?: string;
  // Actual Compose label name; the registered name remains a display name.
  project_name?: string;
  // Present on list responses: merged with projects discovered live from
  // each container's com.docker.compose.project label.
  discovered?: boolean;
  discovery_source?: "container" | "directory";
  running?: number;
  total?: number;
  // List responses only: compose file is readable and a service declares build.
  can_build?: boolean;
}

export interface Registry {
  id: string;
  url: string;
  username: string;
}

export interface DockerServer {
  id: string;
  name: string;
  host: string;
  tls: boolean;
  compose_dir: string;
  has_ca_pem: boolean;
  has_cert_pem: boolean;
  has_key_pem: boolean;
}

export interface DockerSettings {
  servers: DockerServer[];
  active_id: string;
}

export interface DockerInfo {
  host_name: string;
  server_version: string;
  api_version: string;
  min_api_version: string;
  operating_system: string;
  os_type: string;
  architecture: string;
  kernel_version: string;
  n_cpu: number;
  mem_total: number;
  n_goroutines: number;
  n_fds: number;
  docker_root_dir: string;
  storage_driver: string;
  storage_available?: string;
  cgroup_driver: string;
  cgroup_version: string;
  logging_driver: string;
  default_runtime: string;
  live_restore: boolean;
}

export interface AuditEntry {
  time: string;
  user: string;
  action: string;
  target: string;
  result: string;
}

export interface FileEntry {
  name: string;
  path: string;
  is_dir: boolean;
  size: number;
  mode?: string;
  mod_time?: number;
  uname?: string;
  uid?: number;
  gid?: number;
}

export interface Template {
  id: string;
  name: string;
  cmd: string;
  created: string;
}
