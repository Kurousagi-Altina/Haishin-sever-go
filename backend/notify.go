package main

import (
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"
)

const (
	// Server酱 Turbo 的推送接口
	defaultNotifyEndpoint = "https://sctapi.ftqq.com/%s.send"

	notifyIPInterval = 5 * time.Minute  // 同一 IP 的注册通知最小间隔
	notifyMinGap     = 30 * time.Second // 两次通知之间的全局最小间隔
	notifyMaxTracked = 2000             // 记录的 IP 上限，防止内存无限增长
	notifyTimeout    = 10 * time.Second
)

// Notifier 通过 Server酱 Turbo 推送新用户注册提醒。
// sendKey 为空时整个通知功能静默关闭，注册流程不受任何影响。
//
// 注册接口是完全公开的，任何人都能刷，所以这里做了两层节流：
// 同一 IP 5 分钟内只推一条，全局两条之间至少间隔 30 秒。
// 被节流掉的次数会累加，在下一条通知里一并说明。
type Notifier struct {
	sendKey  string
	endpoint string // 形如 .../%s.send，测试时可替换
	client   *http.Client

	ipInterval time.Duration // 同一 IP 的最小推送间隔
	minGap     time.Duration // 两次推送之间的全局最小间隔

	mu         sync.Mutex
	lastGlobal time.Time
	lastByIP   map[string]time.Time
	suppressed int
}

func NewNotifier(sendKey string) *Notifier {
	n := &Notifier{
		sendKey:    strings.TrimSpace(sendKey),
		endpoint:   defaultNotifyEndpoint,
		client:     &http.Client{Timeout: notifyTimeout},
		ipInterval: notifyIPInterval,
		minGap:     notifyMinGap,
		lastByIP:   make(map[string]time.Time),
	}
	if n.Enabled() {
		log.Printf("[NOTIFY] 注册通知已启用（Server酱）")
	} else {
		log.Printf("[NOTIFY] 未配置 notify_sendkey，注册通知已关闭")
	}
	return n
}

func (n *Notifier) Enabled() bool {
	return n != nil && n.sendKey != ""
}

// NotifyRegistration 推送一条注册提醒。同步部分只做内存判断，真正的网络请求在后台进行，
// 保证无论推送成功与否都不会拖慢或影响注册接口。
func (n *Notifier) NotifyRegistration(username, ip string) {
	if !n.Enabled() {
		return
	}

	now := time.Now()

	n.mu.Lock()
	if last, ok := n.lastByIP[ip]; ok && now.Sub(last) < n.ipInterval {
		n.suppressed++
		n.mu.Unlock()
		log.Printf("[NOTIFY] 注册通知被节流（同 IP）: %s", ip)
		return
	}
	if now.Sub(n.lastGlobal) < n.minGap {
		n.suppressed++
		n.mu.Unlock()
		log.Printf("[NOTIFY] 注册通知被节流（全局间隔）: %s", ip)
		return
	}
	n.lastByIP[ip] = now
	n.lastGlobal = now
	merged := n.suppressed
	n.suppressed = 0
	n.pruneLocked(now)
	n.mu.Unlock()

	go n.send(username, ip, merged)
}

// pruneLocked 清理过期的 IP 记录。调用前必须持有 n.mu。
func (n *Notifier) pruneLocked(now time.Time) {
	if len(n.lastByIP) <= notifyMaxTracked {
		return
	}
	for ip, t := range n.lastByIP {
		if now.Sub(t) >= n.ipInterval {
			delete(n.lastByIP, ip)
		}
	}
	// 极端情况：大量不同 IP 在窗口内涌入，直接重置。
	// 丢掉的只是节流记忆，全局间隔仍然兜底。
	if len(n.lastByIP) > notifyMaxTracked {
		n.lastByIP = make(map[string]time.Time)
	}
}

func (n *Notifier) send(username, ip string, merged int) {
	body := "**" + username + "** 提交了注册申请，等待审核。\n\n"
	body += "- IP：`" + ip + "`\n"
	body += "- 时间：" + time.Now().Format("2006-01-02 15:04:05")

	if merged > 0 {
		body += fmt.Sprintf("\n\n> 另有 %d 次注册因过于频繁被合并，未单独推送。", merged)
	}

	form := url.Values{}
	form.Set("title", "新用户注册："+username)
	form.Set("desp", body)

	req, err := http.NewRequest(http.MethodPost, fmt.Sprintf(n.endpoint, n.sendKey), strings.NewReader(form.Encode()))
	if err != nil {
		log.Printf("[NOTIFY] 构造请求失败: %v", err)
		return
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")

	resp, err := n.client.Do(req)
	if err != nil {
		log.Printf("[NOTIFY] 推送失败: %v", err)
		return
	}
	defer resp.Body.Close()

	raw, _ := io.ReadAll(io.LimitReader(resp.Body, 8192))

	// Server酱 出错时也可能返回 HTTP 200，得看 body 里的 code
	var result struct {
		Code    int    `json:"code"`
		Message string `json:"message"`
		Data    struct {
			Error string `json:"error"`
		} `json:"data"`
	}
	if err := json.Unmarshal(raw, &result); err != nil {
		log.Printf("[NOTIFY] 无法解析响应 (HTTP %d): %s", resp.StatusCode, truncateForLog(string(raw)))
		return
	}
	if result.Code != 0 || result.Data.Error != "SUCCESS" {
		log.Printf("[NOTIFY] 推送被拒绝: code=%d message=%s error=%s", result.Code, result.Message, result.Data.Error)
		return
	}

	log.Printf("[NOTIFY] 已推送注册提醒: %s", username)
}

// truncateForLog 截断日志里的响应内容，避免把整页 HTML 写进日志。
func truncateForLog(s string) string {
	s = strings.TrimSpace(s)
	if len(s) > 200 {
		return s[:200] + "..."
	}
	return s
}
