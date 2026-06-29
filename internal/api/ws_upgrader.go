package api

import (
	"net/http"

	"github.com/gorilla/websocket"
)

// ponytail: mirrors ws.upgrader — separate packages, no circular import possible
var upgrader = websocket.Upgrader{
	CheckOrigin: func(r *http.Request) bool { return true },
}
