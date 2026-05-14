package main

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"time"
)

type ZLMClient struct {
	BaseURL string
	Secret  string
	client  *http.Client
}

type ZLMStream struct {
	App              string  `json:"app"`
	Stream           string  `json:"stream"`
	Schema           string  `json:"schema"`
	TotalReaderCount int     `json:"totalReaderCount"`
	OriginSock       ZLMSock `json:"originSock"`
}

type ZLMSock struct {
	Identifier string `json:"identifier"`
}

type ZLMResponse struct {
	Code int          `json:"code"`
	Msg  string       `json:"msg"`
	Data []ZLMStream  `json:"data"`
}

func NewZLMClient(baseURL, secret string) *ZLMClient {
	return &ZLMClient{
		BaseURL: baseURL,
		Secret:  secret,
		client: &http.Client{
			Timeout: 5 * time.Second,
		},
	}
}

func (z *ZLMClient) GetMediaList() ([]ZLMStream, error) {
	url := fmt.Sprintf("%s/index/api/getMediaList?secret=%s", z.BaseURL, z.Secret)
	resp, err := z.client.Get(url)
	if err != nil {
		return nil, fmt.Errorf("ZLM连接失败(%s): %w", z.BaseURL, err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		return nil, fmt.Errorf("ZLM返回错误状态 %d: %s", resp.StatusCode, string(body))
	}

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, fmt.Errorf("读取ZLM响应失败: %w", err)
	}

	var result ZLMResponse
	if err := json.Unmarshal(body, &result); err != nil {
		return nil, fmt.Errorf("解析ZLM响应失败: %w", err)
	}

	if result.Code != 0 {
		return nil, fmt.Errorf("ZLM API异常: code=%d, msg=%s", result.Code, result.Msg)
	}

	return result.Data, nil
}
