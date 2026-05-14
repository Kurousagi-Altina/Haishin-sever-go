//go:build !windows

package main

import "syscall"

func getDiskSpace(path string) (total uint64, free uint64, err error) {
	var stat syscall.Statfs_t
	if err := syscall.Statfs(path, &stat); err != nil {
		return 0, 0, err
	}
	bs := uint64(stat.Bsize)
	return stat.Blocks * bs, stat.Bavail * bs, nil
}
