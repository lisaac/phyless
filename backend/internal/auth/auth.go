package auth

import (
	"context"
	"errors"
	"net/http"
	"strings"
	"time"

	"github.com/golang-jwt/jwt/v5"
	"phyless/backend/internal/models"
)

type Claims struct {
	UserID       string      `json:"user_id"`
	Username     string      `json:"username"`
	Role         models.Role `json:"role"`
	TokenVersion uint64      `json:"token_version,omitempty"`
	jwt.RegisteredClaims
}

type contextKey struct{}

var ErrForbidden = errors.New("forbidden")
var ErrLookup = errors.New("account lookup failed")
var ErrInvalidAccount = errors.New("invalid account")

// UserLookup resolves the account represented by a token. Keeping the
// callback here avoids coupling auth to the on-disk store package.
type UserLookup func(context.Context, string) (*models.User, error)

func GenerateToken(userID, username string, role models.Role, secret []byte) (string, error) {
	return GenerateTokenWithVersion(userID, username, role, 0, secret)
}

func GenerateTokenWithVersion(userID, username string, role models.Role, version uint64, secret []byte) (string, error) {
	if len(secret) == 0 {
		return "", errors.New("empty signing secret")
	}
	claims := Claims{
		UserID:       userID,
		Username:     username,
		Role:         role,
		TokenVersion: version,
		RegisteredClaims: jwt.RegisteredClaims{
			ExpiresAt: jwt.NewNumericDate(time.Now().Add(24 * time.Hour)),
			IssuedAt:  jwt.NewNumericDate(time.Now()),
		},
	}
	return jwt.NewWithClaims(jwt.SigningMethodHS256, claims).SignedString(secret)
}

func ValidateToken(token string, secret []byte) (*Claims, error) {
	if token == "" || len(secret) == 0 {
		return nil, errors.New("invalid token")
	}
	t, err := jwt.ParseWithClaims(token, &Claims{}, func(t *jwt.Token) (any, error) {
		if _, ok := t.Method.(*jwt.SigningMethodHMAC); !ok {
			return nil, errors.New("unexpected signing method")
		}
		return secret, nil
	})
	if err != nil {
		return nil, err
	}
	claims, ok := t.Claims.(*Claims)
	if !ok || !t.Valid {
		return nil, errors.New("invalid token")
	}
	return claims, nil
}

func Middleware(secret []byte, minRole models.Role) func(http.Handler) http.Handler {
	return middleware(secret, minRole, nil)
}

// MiddlewareWithUser validates the token against the current account so role,
// deletion, password changes, and explicit token-version revocation take
// effect immediately.
func MiddlewareWithUser(secret []byte, minRole models.Role, lookup UserLookup) func(http.Handler) http.Handler {
	return middleware(secret, minRole, lookup)
}

func middleware(secret []byte, minRole models.Role, lookup UserLookup) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			header := r.Header.Get("Authorization")
			token := strings.TrimSpace(strings.TrimPrefix(header, "Bearer "))
			if token == "" {
				http.Error(w, "unauthorized", http.StatusUnauthorized)
				return
			}
			claims, err := authenticate(r.Context(), token, secret, lookup)
			if err != nil {
				status := http.StatusUnauthorized
				if errors.Is(err, ErrLookup) {
					status = http.StatusServiceUnavailable
				}
				http.Error(w, http.StatusText(status), status)
				return
			}
			if claims.Role.Level() < minRole.Level() {
				http.Error(w, "forbidden", http.StatusForbidden)
				return
			}
			next.ServeHTTP(w, r.WithContext(WithClaims(r.Context(), claims)))
		})
	}
}

// Authenticate validates a token and returns a context carrying its claims.
// It is shared by header and query-token authentication paths.
func Authenticate(ctx context.Context, token string, secret []byte, minRole models.Role, lookup UserLookup) (context.Context, *Claims, error) {
	claims, err := authenticate(ctx, strings.TrimSpace(token), secret, lookup)
	if err != nil {
		return ctx, nil, err
	}
	if claims.Role.Level() < minRole.Level() {
		return ctx, nil, ErrForbidden
	}
	return WithClaims(ctx, claims), claims, nil
}

func authenticate(ctx context.Context, token string, secret []byte, lookup UserLookup) (*Claims, error) {
	claims, err := ValidateToken(token, secret)
	if err != nil {
		return nil, err
	}
	if lookup != nil {
		user, err := lookup(ctx, claims.UserID)
		if err != nil {
			return nil, errors.Join(ErrLookup, err)
		}
		if user == nil || user.TokenVersion != claims.TokenVersion || !user.Role.Valid() {
			return nil, ErrInvalidAccount
		}
		claims.Username = user.Username
		claims.Role = user.Role
		claims.TokenVersion = user.TokenVersion
	}
	return claims, nil
}

func WithClaims(ctx context.Context, claims *Claims) context.Context {
	return context.WithValue(ctx, contextKey{}, claims)
}

func FromContext(ctx context.Context) *Claims {
	c, _ := ctx.Value(contextKey{}).(*Claims)
	return c
}
