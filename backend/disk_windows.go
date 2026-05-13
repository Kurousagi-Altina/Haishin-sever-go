//go:build windows

package main

import "errors"

func getDiskFreeSpace(path string) (uint64, error) {
	return 0, errors.New("disk space not available on this platform")
}
