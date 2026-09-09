package compose

import (
	"os"
	"path/filepath"
	"reflect"
	"sort"
	"testing"

	composetypes "github.com/compose-spec/compose-go/v2/types"
)

func strptr(s string) *string { return &s }

func TestBuildBaseImages(t *testing.T) {
	dir := t.TempDir()
	dockerfile := `
ARG BASE=alpine
ARG TAG=3.19
FROM ${BASE}:${TAG} AS build
RUN echo hi
FROM golang:1.22 AS tools
FROM build
FROM scratch
COPY --from=build /x /x
`
	if err := os.WriteFile(filepath.Join(dir, "Dockerfile"), []byte(dockerfile), 0o600); err != nil {
		t.Fatal(err)
	}
	svc := composetypes.ServiceConfig{Build: &composetypes.BuildConfig{Context: dir}}
	got, err := BuildBaseImages(svc, dir)
	if err != nil {
		t.Fatal(err)
	}
	sort.Strings(got)
	want := []string{"alpine:3.19", "golang:1.22"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("bases = %v, want %v", got, want)
	}
}

func TestBuildBaseImagesBuildArgOverride(t *testing.T) {
	svc := composetypes.ServiceConfig{Build: &composetypes.BuildConfig{
		DockerfileInline: "ARG TAG=3.19\nFROM alpine:${TAG}\n",
		Args:             composetypes.MappingWithEquals{"TAG": strptr("3.20")},
	}}
	got, err := BuildBaseImages(svc, "")
	if err != nil {
		t.Fatal(err)
	}
	want := []string{"alpine:3.20"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("bases = %v, want %v", got, want)
	}
}

func TestBuildBaseImagesNoBuild(t *testing.T) {
	got, err := BuildBaseImages(composetypes.ServiceConfig{}, "")
	if err != nil || got != nil {
		t.Fatalf("bases = %v, err = %v, want nil,nil", got, err)
	}
}
