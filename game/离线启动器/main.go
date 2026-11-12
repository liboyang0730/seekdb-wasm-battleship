// 自带本机网页服务；只读取同目录单页游戏，不安装数据库或修改浏览器设置。
package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"flag"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"syscall"
	"time"
)

const pageName = "seekdb大海戦.html"

func stopWithMessage(message string) {
	fmt.Fprintln(os.Stderr, message)
	if runtime.GOOS == "windows" {
		fmt.Print("按回车关闭窗口。")
		_, _ = fmt.Scanln()
	}
	os.Exit(1)
}

func openBrowser(url string) error {
	if runtime.GOOS == "darwin" {
		return exec.Command("open", url).Start()
	}
	if runtime.GOOS == "windows" {
		return exec.Command("rundll32.exe", "url.dll,FileProtocolHandler", url).Start()
	}
	if path, err := exec.LookPath("xdg-open"); err == nil {
		return exec.Command(path, url).Start()
	}
	return fmt.Errorf("无法打开系统默认浏览器")
}

func sameGame(port int, digest string) bool {
	client := &http.Client{
		Timeout:       500 * time.Millisecond,
		Transport:     &http.Transport{Proxy: nil, DisableKeepAlives: true},
		CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
	}
	response, err := client.Head("http://127.0.0.1:" + strconv.Itoa(port) + "/")
	if err != nil {
		return false
	}
	defer response.Body.Close()
	return response.StatusCode == http.StatusOK && response.Header.Get("X-Seekdb-Playtest") == digest &&
		response.Header.Get("Cross-Origin-Opener-Policy") == "same-origin" &&
		response.Header.Get("Cross-Origin-Embedder-Policy") == "require-corp"
}

func listenForGame(port int, digest string) (net.Listener, error) {
	if port < 1 || port > 65535 {
		return nil, fmt.Errorf("本机固定端口必须在1到65535之间；不能使用随机端口")
	}
	listener, err := net.Listen("tcp4", "127.0.0.1:"+strconv.Itoa(port))
	if err == nil {
		return listener, nil
	}
	if sameGame(port, digest) {
		return nil, nil
	}
	// OPFS按网址隔离；自动换端口会让玩家看不到原来的本地存档。
	return nil, fmt.Errorf("固定地址 http://127.0.0.1:%d/ 暂不可用。请关闭旧启动器或释放该端口后重试；为保留原存档地址，不会自动改用其他端口。", port)
}

func main() {
	port := flag.Int("port", 8876, "本机固定端口；改动端口将使用不同的本地存档")
	noOpen := flag.Bool("no-open", false, "不自动打开系统默认浏览器，供验证使用")
	pageArg := flag.String("html", "", "游戏HTML路径，默认与启动器同目录")
	flag.Parse()
	executable, err := os.Executable()
	if err != nil {
		stopWithMessage("无法确定启动器目录：" + err.Error())
	}
	path := *pageArg
	if path == "" {
		path = filepath.Join(filepath.Dir(executable), pageName)
	}
	body, err := os.ReadFile(path)
	if err != nil {
		stopWithMessage("没有找到游戏文件，请先完整解压试玩包，再双击开始试玩。\n" + err.Error())
	}
	sum := sha256.Sum256(body)
	digest := hex.EncodeToString(sum[:])
	listener, err := listenForGame(*port, digest)
	if err != nil {
		stopWithMessage(err.Error())
	}
	if listener == nil {
		url := "http://127.0.0.1:" + strconv.Itoa(*port) + "/"
		fmt.Println("已复用同一游戏服务：", url)
		if !*noOpen {
			if err := openBrowser(url); err != nil {
				fmt.Println("请将网址复制到Safari、Chrome、Edge或Firefox打开：", url)
			}
		}
		return
	}
	mux := http.NewServeMux()
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cross-Origin-Opener-Policy", "same-origin")
		w.Header().Set("Cross-Origin-Embedder-Policy", "require-corp")
		w.Header().Set("Cross-Origin-Resource-Policy", "same-origin")
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("Cache-Control", "no-store")
		w.Header().Set("X-Seekdb-Playtest", digest)
		if r.Method != http.MethodGet && r.Method != http.MethodHead {
			w.Header().Set("Allow", "GET, HEAD")
			http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
			return
		}
		if r.URL.Path == "/favicon.ico" {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		if r.URL.Path != "/" && r.URL.Path != "/index.html" && r.URL.Path != "/"+pageName {
			http.NotFound(w, r)
			return
		}
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		w.Header().Set("Content-Length", strconv.Itoa(len(body)))
		if r.Method == http.MethodGet {
			_, _ = w.Write(body)
		}
	})
	server := &http.Server{Handler: mux, ReadHeaderTimeout: 5 * time.Second, IdleTimeout: 15 * time.Second, MaxHeaderBytes: 16 * 1024}
	url := "http://" + listener.Addr().String() + "/"
	fmt.Println("seekdb 大海戦 · 离线试玩")
	fmt.Println(url)
	fmt.Println("不需要联网或安装数据库。试玩时保留此窗口，结束后关闭即可。")
	if !*noOpen {
		if err := openBrowser(url); err != nil {
			fmt.Println("请复制以上网址到电脑端Safari、Chrome、Edge或Firefox打开。")
		}
	}
	signals := make(chan os.Signal, 1)
	signal.Notify(signals, os.Interrupt, syscall.SIGTERM)
	go func() {
		<-signals
		ctx, cancel := context.WithTimeout(context.Background(), time.Second)
		defer cancel()
		_ = server.Shutdown(ctx)
	}()
	if err := server.Serve(listener); err != nil && err != http.ErrServerClosed && !strings.Contains(err.Error(), "use of closed network connection") {
		_, _ = io.WriteString(os.Stderr, "启动失败："+err.Error()+"\n")
	}
}
