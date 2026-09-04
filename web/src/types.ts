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
  Size: number;
  Created: number;
  UsedBy?: { Id: string; Name: string }[];
}

export interface NetworkSummary {
  Id: string;
  Name: string;
  Driver: string;
  Scope: string;
}

export interface VolumeSummary {
  Name: string;
  Driver: string;
  Mountpoint: string;
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
  running?: number;
  total?: number;
}

export interface Registry {
  id: string;
  url: string;
  username: string;
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
