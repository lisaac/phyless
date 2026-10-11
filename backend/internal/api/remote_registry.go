package api

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"strings"
	"time"

	"phyless/backend/internal/docker"
)

// hubAPIBase is where Docker Hub API requests go; tests point it elsewhere.
var hubAPIBase = "https://hub.docker.com"

const maxRemoteResponse = 1 << 20

var (
	hubTagsPath = regexp.MustCompile(`^/v2/namespaces/[a-z0-9._-]+/repositories/[a-z0-9._-]+/tags$`)
	v2TagsPath  = regexp.MustCompile(`^/v2/([a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*(?:/[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*)*)/tags/list$`)
	// Manifests by tag or digest, and blobs by digest (only small ones: configs).
	v2ObjectPath = regexp.MustCompile(`^/v2/([a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*(?:/[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*)*)/(manifests/(?:[\w][\w.-]{0,127}|sha256:[a-f0-9]{64})|blobs/sha256:[a-f0-9]{64})$`)
)

// handleRemoteRegistry runs the remote image search's read-only lookups over
// the same network path a pull with these options would use: phyless's own
// network, or the request's pull proxy. Only two kinds of target exist:
// Docker Hub's search/tag API (body relayed as-is) and any registry's V2 tag
// list (authenticated with the selected registry account).
func (s *Server) handleRemoteRegistry(w http.ResponseWriter, r *http.Request) {
	var body struct {
		URL    string `json:"url"`
		Accept string `json:"accept"`
		requestPullOptions
	}
	if err := json.NewDecoder(io.LimitReader(r.Body, 64<<10)).Decode(&body); err != nil {
		writeError(w, http.StatusBadRequest, "invalid JSON")
		return
	}
	target, err := url.Parse(body.URL)
	if err != nil || target.Scheme != "https" || target.User != nil || target.Fragment != "" {
		writeError(w, http.StatusBadRequest, "invalid target")
		return
	}
	ctx, err := s.pullContext(r.Context(), body.ProxyURL)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	ctx, cancel := context.WithTimeout(ctx, 20*time.Second)
	defer cancel()
	transport, err := docker.RequestTransport(ctx)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	defer transport.CloseIdleConnections()

	switch {
	case target.Host == "hub.docker.com" && (target.Path == "/v2/search/repositories/" || hubTagsPath.MatchString(target.Path)):
		s.relayHub(ctx, w, transport, target)
	case v2TagsPath.MatchString(target.Path):
		repository := v2TagsPath.FindStringSubmatch(target.Path)[1]
		host, err := docker.RegistryHost(target.Host)
		if err != nil {
			writeError(w, http.StatusBadRequest, "invalid registry")
			return
		}
		ref := host + "/" + repository
		auth, err := s.requestRegistryAuth(ref, body.requestPullOptions)
		if err != nil && err.Error() != "selected registry does not match image host" {
			writeError(w, http.StatusBadRequest, err.Error())
			return
		}
		// An account selected for another registry lists anonymously.
		tags, err := docker.ListTags(ctx, transport, ref, auth)
		if err != nil {
			writeError(w, remoteStatus(err), err.Error())
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"tags": tags})
	case v2ObjectPath.MatchString(target.Path):
		repository := v2ObjectPath.FindStringSubmatch(target.Path)[1]
		host, err := docker.RegistryHost(target.Host)
		if err != nil {
			writeError(w, http.StatusBadRequest, "invalid registry")
			return
		}
		auth, err := s.requestRegistryAuth(host+"/"+repository, body.requestPullOptions)
		if err != nil && err.Error() != "selected registry does not match image host" {
			writeError(w, http.StatusBadRequest, err.Error())
			return
		}
		resp, err := docker.RegistryGet(ctx, transport, host, repository, target.Path, body.Accept, auth)
		if err != nil {
			writeError(w, remoteStatus(err), err.Error())
			return
		}
		defer resp.Body.Close()
		limit := int64(4 << 20)
		if strings.Contains(target.Path, "/blobs/") {
			limit = maxRemoteResponse
		}
		data, err := io.ReadAll(io.LimitReader(resp.Body, limit+1))
		if err != nil || int64(len(data)) > limit {
			writeError(w, http.StatusBadGateway, "registry object is too large")
			return
		}
		if resp.StatusCode != http.StatusOK {
			writeError(w, upstreamStatus(resp.StatusCode), fmt.Sprintf("registry returned HTTP %d", resp.StatusCode))
			return
		}
		for _, h := range []string{"Content-Type", "Docker-Content-Digest"} {
			if v := resp.Header.Get(h); v != "" {
				w.Header().Set(h, v)
			}
		}
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write(data)
	default:
		writeError(w, http.StatusBadRequest, "unsupported remote target")
	}
}

func (s *Server) relayHub(ctx context.Context, w http.ResponseWriter, transport http.RoundTripper, target *url.URL) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, hubAPIBase+target.Path+"?"+target.RawQuery, nil)
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid target")
		return
	}
	req.Header.Set("Accept", "application/json")
	client := &http.Client{Transport: transport, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	resp, err := client.Do(req)
	if err != nil {
		if ctx.Err() != nil {
			writeError(w, http.StatusGatewayTimeout, "Docker Hub request timed out")
		} else {
			// Never echo the transport error: it can carry the proxy URL.
			writeError(w, http.StatusBadGateway, "cannot reach Docker Hub")
		}
		return
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		if retry := resp.Header.Get("Retry-After"); retry != "" {
			w.Header().Set("Retry-After", retry)
		}
		writeError(w, upstreamStatus(resp.StatusCode), fmt.Sprintf("Docker Hub returned HTTP %d", resp.StatusCode))
		return
	}
	data, err := io.ReadAll(io.LimitReader(resp.Body, maxRemoteResponse+1))
	if err != nil || len(data) > maxRemoteResponse || !json.Valid(data) {
		writeError(w, http.StatusBadGateway, "invalid Docker Hub response")
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(data)
}

// upstreamStatus keeps the registry's status for the UI's messages, except
// 401: that would read as phyless's own session expiring and log the user out.
func upstreamStatus(code int) int {
	if code == http.StatusUnauthorized {
		return http.StatusForbidden
	}
	return code
}

func remoteStatus(err error) int {
	msg := err.Error()
	for _, code := range []int{http.StatusUnauthorized, http.StatusForbidden, http.StatusNotFound, http.StatusTooManyRequests} {
		if strings.Contains(msg, fmt.Sprintf("HTTP %d", code)) {
			return upstreamStatus(code)
		}
	}
	if strings.Contains(msg, "timed out") {
		return http.StatusGatewayTimeout
	}
	return http.StatusBadGateway
}
