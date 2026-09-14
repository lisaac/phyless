package models

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

type Template struct {
	ID      string `json:"id"`
	Name    string `json:"name"`
	Cmd     string `json:"cmd"` // docker run command
	Created string `json:"created"`
}
