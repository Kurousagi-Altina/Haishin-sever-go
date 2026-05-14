.PHONY: build test clean

BIN := liveserver
TEST_BIN := liveserver-test
BUILD_DIR := build

build:
	@mkdir -p $(BUILD_DIR)
	CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -ldflags="-s -w" -o $(BUILD_DIR)/$(BIN) .

test:
	@mkdir -p $(BUILD_DIR)
	CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -o $(BUILD_DIR)/$(TEST_BIN) .

clean:
	rm -rf $(BUILD_DIR)
