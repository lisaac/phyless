// Package web embeds the built Vite frontend into the Go binary.
package web

import "embed"

// Dist holds web/dist. A tracked dist/.gitkeep keeps this compiling on a fresh
// clone that has not run `npm run build`; the server skips the SPA routes when
// index.html is missing.
//
//go:embed all:dist
var Dist embed.FS
