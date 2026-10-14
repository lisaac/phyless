package docker

// RoleLabel marks every phyless-owned helper object — containers, the debug
// image and the busybox volume — so listings and counts can hide them.
const RoleLabel = "phyless.role"

// IsHelper reports whether labels belong to a phyless helper object.
func IsHelper(labels map[string]string) bool { return labels[RoleLabel] != "" }
