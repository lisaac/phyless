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
  Ports: { PrivatePort: number; PublicPort?: number; Type: string }[];
  Mounts: { Source: string; Destination: string }[];
  Command: string;
}

export interface ImageSummary {
  Id: string;
  RepoTags: string[];
  Size: number;
  Created: number;
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
}

export interface ComposeProject {
  id: string;
  name: string;
  base_dir: string;
  compose_file: string;
  env_file?: string;
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
  is_dir: boolean;
  size: number;
  mode?: string;
}

export interface Template {
  id: string;
  name: string;
  cmd: string;
  created: string;
}
