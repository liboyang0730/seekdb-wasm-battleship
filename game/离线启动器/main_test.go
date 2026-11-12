package main

import (
	"net"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"
)

func serverPort(t *testing.T, server *httptest.Server) int {
	t.Helper()
	_, portText, err := net.SplitHostPort(server.Listener.Addr().String())
	if err != nil {
		t.Fatal(err)
	}
	port, err := strconv.Atoi(portText)
	if err != nil {
		t.Fatal(err)
	}
	return port
}

func TestListenForGameUsesRequestedPort(t *testing.T) {
	// 只用临时端口做本机验证，不占用玩家的默认存档地址。
	reservation, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	port := reservation.Addr().(*net.TCPAddr).Port
	if err := reservation.Close(); err != nil {
		t.Fatal(err)
	}
	listener, err := listenForGame(port, "current-html")
	if err != nil {
		t.Fatal(err)
	}
	if listener == nil {
		t.Fatal("空闲端口应创建服务，而非复用不存在的服务")
	}
	defer listener.Close()
	if want := "127.0.0.1:" + strconv.Itoa(port); listener.Addr().String() != want {
		t.Fatalf("监听地址=%s，期望=%s", listener.Addr(), want)
	}
}

func TestListenForGameReusesMatchingHTML(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodHead || r.URL.Path != "/" {
			t.Errorf("复用检查应仅HEAD当前网址，实际=%s %s", r.Method, r.URL.Path)
		}
		w.Header().Set("X-Seekdb-Playtest", "same-html")
		w.Header().Set("Cross-Origin-Opener-Policy", "same-origin")
		w.Header().Set("Cross-Origin-Embedder-Policy", "require-corp")
	}))
	defer server.Close()
	listener, err := listenForGame(serverPort(t, server), "same-html")
	if err != nil || listener != nil {
		if listener != nil {
			listener.Close()
		}
		t.Fatalf("同一游戏应复用已有服务，listener=%v error=%v", listener, err)
	}
}

func TestListenForGameRejectsConflictsWithoutChangingPort(t *testing.T) {
	for _, mode := range []string{"different-html", "missing-isolation", "not-found", "redirect"} {
		t.Run(mode, func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				w.Header().Set("X-Seekdb-Playtest", "same-html")
				w.Header().Set("Cross-Origin-Opener-Policy", "same-origin")
				w.Header().Set("Cross-Origin-Embedder-Policy", "require-corp")
				switch mode {
				case "different-html":
					w.Header().Set("X-Seekdb-Playtest", "older-html")
				case "missing-isolation":
					w.Header().Del("Cross-Origin-Embedder-Policy")
				case "not-found":
					w.WriteHeader(http.StatusNotFound)
				case "redirect":
					http.Redirect(w, r, "/index.html", http.StatusFound)
				}
			}))
			defer server.Close()
			port := serverPort(t, server)
			listener, err := listenForGame(port, "same-html")
			if listener != nil {
				listener.Close()
				t.Fatal("端口冲突后不应自动改用另一端口")
			}
			if err == nil || !strings.Contains(err.Error(), strconv.Itoa(port)) || !strings.Contains(err.Error(), "关闭旧启动器") {
				t.Fatalf("应解释固定端口及释放方法，实际=%v", err)
			}
			// 冲突处理后原服务仍在，启动器没有停止其他进程或监听器。
			client := &http.Client{CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
			response, requestErr := client.Head(server.URL)
			if requestErr != nil {
				t.Fatalf("不应影响占用端口的原服务：%v", requestErr)
			}
			response.Body.Close()
		})
	}
}

func TestListenForGameRejectsNonFixedPorts(t *testing.T) {
	for _, port := range []int{-1, 0, 65536} {
		listener, err := listenForGame(port, "same-html")
		if listener != nil {
			listener.Close()
		}
		if err == nil {
			t.Errorf("应拒绝非法或系统随机端口：%d", port)
		}
	}
}
