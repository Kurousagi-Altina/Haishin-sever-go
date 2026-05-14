//go:build windows

package main

import "errors"

func getDiskSpace(path string) (total uint64, free uint64, err error) {
	return 0, 0, errors.New("disk space not available on this platform")
}
