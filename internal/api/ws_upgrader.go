package api

import "github.com/gorilla/websocket"

// Gorilla's default policy accepts same-origin browser requests.
var upgrader = websocket.Upgrader{}
