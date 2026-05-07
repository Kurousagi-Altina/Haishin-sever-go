package main

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
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
		client:  &http.Client{},
	}
}

func (z *ZLMClient) GetMediaList() ([]ZLMStream, error) {
	url := fmt.Sprintf("%s/index/api/getMediaList?secret=%s", z.BaseURL, z.Secret)
	resp, err := z.client.Get(url)
	if err != nil {
		return nil, fmt.Errorf("ZLM request failed: %w", err)
	}
	defer resp.Body.Close()

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, fmt.Errorf("read ZLM response failed: %w", err)
	}

	var result ZLMResponse
	if err := json.Unmarshal(body, &result); err != nil {
		return nil, fmt.Errorf("parse ZLM response failed: %w", err)
	}

	if result.Code != 0 {
		return nil, fmt.Errorf("ZLM API error: code=%d, msg=%s", result.Code, result.Msg)
	}

	return result.Data, nil
}
