package models

import "time"

type Role string

const (
	RoleAdmin    Role = "admin"
	RoleOperator Role = "operator"
	RoleViewer   Role = "viewer"
)

func (r Role) Level() int {
	switch r {
	case RoleAdmin:
		return 3
	case RoleOperator:
		return 2
	case RoleViewer:
		return 1
	}
	return 0
}

func (r Role) Valid() bool { return r.Level() > 0 }

type User struct {
	ID           string `json:"id"`
	Username     string `json:"username"`
	PasswordHash string `json:"password_hash"`
	Role         Role   `json:"role"`
	TokenVersion uint64 `json:"token_version,omitempty"`
}

type ComposeProject struct {
	ID          string `json:"id"`
	Name        string `json:"name"`
	BaseDir     string `json:"base_dir"`
	ComposeFile string `json:"compose_file"`
	EnvFile     string `json:"env_file,omitempty"`
}

type Registry struct {
	ID          string `json:"id"`
	URL         string `json:"url"`
	Username    string `json:"username"`
	PasswordEnc string `json:"password_enc"`
}

// DockerEndpoint selects the daemon used by the server. TLS material stays as
// PEM text in the config file so a mounted /data volume is the only storage it
// needs.
type DockerEndpoint struct {
	Host    string `json:"host,omitempty"`
	TLS     bool   `json:"tls"`
	CAPEM   string `json:"ca_pem,omitempty"`
	CertPEM string `json:"cert_pem,omitempty"`
	KeyPEM  string `json:"key_pem,omitempty"`
}

const LocalDockerServerID = "local"

// DockerServer is one selectable Docker daemon. Embedding keeps the PEM text
// fields flat in config.json while API responses can omit them explicitly.
type DockerServer struct {
	ID         string `json:"id"`
	Name       string `json:"name"`
	ComposeDir string `json:"compose_dir,omitempty"` // legacy; migrated into Config.ComposeDirs
	DockerEndpoint
}

type Template struct {
	ID      string `json:"id"`
	Name    string `json:"name"`
	Cmd     string `json:"cmd"` // docker run command
	Created string `json:"created"`
}

// AutoUpdatePolicy schedules an update check, and optionally the update, of
// one container or Compose project. See docs/auto-update.md.
type AutoUpdatePolicy struct {
	ID       string   `json:"id"`
	Kind     string   `json:"kind"`   // "container" | "compose"
	Target   string   `json:"target"` // container name, or Compose project id
	ServerID string   `json:"server_id"`
	Enabled  bool     `json:"enabled"`
	Mode     string   `json:"mode"` // "check" | "update"
	Schedule Schedule `json:"schedule"`
	// Server-side pull path only: a schedule runs with no browser attached.
	ProxyURL       string   `json:"proxy_url,omitempty"`
	RegistryIDs    []string `json:"registry_ids,omitempty"`
	RemoveOldImage bool     `json:"remove_old_image,omitempty"`

	// UpdatedAt is the schedule's starting point until the first run.
	UpdatedAt  time.Time  `json:"updated_at"`
	LastRunAt  *time.Time `json:"last_run_at,omitempty"`
	LastStatus string     `json:"last_status,omitempty"`
	LastError  string     `json:"last_error,omitempty"`
	LastLog    []string   `json:"last_log,omitempty"`
	// MissingSince is when a run first found the target gone. Policies are
	// never deleted automatically: the same name may come back (docker rm +
	// run, compose recreate), which clears it.
	MissingSince *time.Time `json:"missing_since,omitempty"`
	// The last actual update attempt, kept apart from Last*, which every
	// check overwrites. Message says what changed, or why it failed.
	LastUpdateAt      *time.Time `json:"last_update_at,omitempty"`
	LastUpdateStatus  string     `json:"last_update_status,omitempty"`
	LastUpdateMessage string     `json:"last_update_message,omitempty"`
}

// Schedule: Kind picks the fields that apply.
//
//	hours:   Every (1–168) hours after the previous run
//	daily:   Time ("HH:MM")
//	weekly:  Weekday (0 = Sunday) at Time
//	monthly: Day (1–31, clamped to the month's last day) at Time
type Schedule struct {
	Kind    string `json:"kind"`
	Every   int    `json:"every,omitempty"`
	Time    string `json:"time,omitempty"`
	Weekday int    `json:"weekday,omitempty"`
	Day     int    `json:"day,omitempty"`
}
