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

type User struct {
	ID           string `json:"id"`
	Username     string `json:"username"`
	PasswordHash string `json:"password_hash"`
	Role         Role   `json:"role"`
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

type Template struct {
	ID      string `json:"id"`
	Name    string `json:"name"`
	Cmd     string `json:"cmd"` // docker run command
	Created string `json:"created"`
}
