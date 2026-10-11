package docker

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/google/go-containerregistry/pkg/authn"
	"github.com/google/go-containerregistry/pkg/name"
	"github.com/google/go-containerregistry/pkg/registry"
	v1 "github.com/google/go-containerregistry/pkg/v1"
	"github.com/google/go-containerregistry/pkg/v1/empty"
	"github.com/google/go-containerregistry/pkg/v1/mutate"
	"github.com/google/go-containerregistry/pkg/v1/random"
	"github.com/google/go-containerregistry/pkg/v1/remote"
)

func TestDaemonPlatformMatchesDockerPullSelection(t *testing.T) {
	cases := map[string]string{
		"x86_64":   "linux/amd64",
		"amd64":    "linux/amd64",
		"aarch64":  "linux/arm64",
		" ARM64 ":  "linux/arm64",
		"armv7l":   "linux/arm/v7",
		"armhf":    "linux/arm/v7",
		"armv6l":   "linux/arm/v6",
		"armv5tel": "linux/arm/v5",
		"i686":     "linux/386",
		"ppc64le":  "linux/ppc64le",
		"s390x":    "linux/s390x",
		"riscv64":  "linux/riscv64",
	}
	for arch, want := range cases {
		if got := DaemonPlatform("Linux", arch).String(); got != want {
			t.Errorf("DaemonPlatform(%q) = %s, want %s", arch, got, want)
		}
	}
}

func TestCompatiblePlatformsFallsBackThroughArmVariants(t *testing.T) {
	got := ""
	for _, p := range compatiblePlatforms(v1.Platform{OS: "linux", Architecture: "arm", Variant: "v7"}) {
		got += p.String() + " "
	}
	if got != "linux/arm/v7 linux/arm/v6 linux/arm/v5 " {
		t.Fatalf("arm/v7 order: %s", got)
	}
	if ps := compatiblePlatforms(v1.Platform{OS: "linux", Architecture: "arm64"}); len(ps) != 1 || ps[0].Architecture != "arm64" {
		t.Fatalf("arm64: %v", ps)
	}
}

func TestGetImageFallsBackToOlderArmVariant(t *testing.T) {
	reg := httptest.NewServer(registry.New())
	defer reg.Close()
	img, err := random.Image(64, 1)
	if err != nil {
		t.Fatal(err)
	}
	idx := mutate.AppendManifests(empty.Index, mutate.IndexAddendum{
		Add:        img,
		Descriptor: v1.Descriptor{Platform: &v1.Platform{OS: "linux", Architecture: "arm", Variant: "v6"}},
	})
	ref, err := name.NewTag(strings.TrimPrefix(reg.URL, "http://") + "/app:latest")
	if err != nil {
		t.Fatal(err)
	}
	if err := remote.WriteIndex(ref, idx); err != nil {
		t.Fatal(err)
	}
	rt := &metadataLimitTransport{inner: http.DefaultTransport}
	v7 := v1.Platform{OS: "linux", Architecture: "arm", Variant: "v7"}
	_, _, chosen, err := getImage(context.Background(), ref, v7, true, authn.Anonymous, rt)
	if err != nil || chosen.Variant != "v6" {
		t.Fatalf("chosen %v, err %v", chosen, err)
	}
	if _, _, _, err := getImage(context.Background(), ref, v7, false, authn.Anonymous, rt); err == nil {
		t.Fatal("a user-chosen arm/v7 must not fall back to v6")
	}
	if _, _, _, err := getImage(context.Background(), ref, v1.Platform{OS: "linux", Architecture: "arm64"}, true, authn.Anonymous, rt); err == nil {
		t.Fatal("arm64 must not fall back to 32-bit arm")
	}
}
