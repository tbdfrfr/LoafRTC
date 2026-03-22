package main

import (
	"bufio"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"math"
	"os"
	"strings"
	"syscall"
	"unsafe"

	"github.com/Microsoft/go-winio"
)

const pipeName = `\\.\pipe\loafrtc-input`

const (
	inputMouse    = 0
	inputKeyboard = 1

	mouseeventfMove       = 0x0001
	mouseeventfLeftDown   = 0x0002
	mouseeventfLeftUp     = 0x0004
	mouseeventfRightDown  = 0x0008
	mouseeventfRightUp    = 0x0010
	mouseeventfMiddleDown = 0x0020
	mouseeventfMiddleUp   = 0x0040
	mouseeventfWheel      = 0x0800
	mouseeventfAbsolute   = 0x8000

	keyeventfKeyUp = 0x0002
)

var (
	modUser32      = syscall.NewLazyDLL("user32.dll")
	procSendInput  = modUser32.NewProc("SendInput")
	procGetMetrics = modUser32.NewProc("GetSystemMetrics")
)

type inboundEvent struct {
	Type    string  `json:"type"`
	Event   string  `json:"event"`
	Code    string  `json:"code"`
	Key     string  `json:"key"`
	X       float64 `json:"x"`
	Y       float64 `json:"y"`
	DX      float64 `json:"dx"`
	DY      float64 `json:"dy"`
	DeltaX  float64 `json:"deltaX"`
	DeltaY  float64 `json:"deltaY"`
	Button  int32   `json:"button"`
	Buttons int32   `json:"buttons"`
}

type mouseInput struct {
	Dx          int32
	Dy          int32
	MouseData   uint32
	DwFlags     uint32
	Time        uint32
	DwExtraInfo uintptr
}

type keyboardInput struct {
	WVKey       uint16
	WScan       uint16
	DwFlags     uint32
	Time        uint32
	DwExtraInfo uintptr
}

type hardwareInput struct {
	UMsg    uint32
	WParamL uint16
	WParamH uint16
}

type inputUnion struct {
	Mi mouseInput
	Ki keyboardInput
}

type input struct {
	Type uint32
	Iu   inputUnion
}

func main() {
	if os.Getenv("LOAFRTC_INPUT_BRIDGE_QUIET") == "1" {
		log.SetOutput(os.Stdout)
	}

	for {
		listener, err := winio.ListenPipe(pipeName, nil)
		if err != nil {
			log.Fatalf("failed to listen on named pipe: %v", err)
		}

		conn, err := listener.Accept()
		listener.Close()
		if err != nil {
			log.Printf("accept failed: %v", err)
			continue
		}

		log.Printf("client connected")
		handleConnection(conn)
		_ = conn.Close()
		log.Printf("client disconnected")
	}
}

func handleConnection(conn interface {
	Read([]byte) (int, error)
}) {
	scanner := bufio.NewScanner(conn)
	scanner.Buffer(make([]byte, 0, 4096), 64*1024)

	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if line == "" {
			continue
		}

		var event inboundEvent
		if err := json.Unmarshal([]byte(line), &event); err != nil {
			log.Printf("invalid JSON event: %v", err)
			continue
		}

		if err := dispatchEvent(event); err != nil {
			log.Printf("event dispatch error: %v", err)
		}
	}

	if err := scanner.Err(); err != nil {
		log.Printf("pipe read error: %v", err)
	}
}

func dispatchEvent(event inboundEvent) error {
	switch event.Event {
	case "mousemove":
		return injectMouseMove(event.X, event.Y)
	case "mousedown":
		return injectMouseButton(event.Button, true)
	case "mouseup":
		return injectMouseButton(event.Button, false)
	case "scroll":
		return injectMouseScroll(event.DeltaY)
	case "keydown":
		return injectKeyboard(event.Code, true)
	case "keyup":
		return injectKeyboard(event.Code, false)
	default:
		return fmt.Errorf("unsupported event: %s", event.Event)
	}
}

func injectMouseMove(normalizedX, normalizedY float64) error {
	width := getSystemMetric(0)
	height := getSystemMetric(1)
	if width <= 0 || height <= 0 {
		return errors.New("invalid screen dimensions")
	}

	x := int32(clamp(normalizedX, 0.0, 1.0) * 65535.0)
	y := int32(clamp(normalizedY, 0.0, 1.0) * 65535.0)

	mi := mouseInput{
		Dx:      x,
		Dy:      y,
		DwFlags: mouseeventfMove | mouseeventfAbsolute,
	}

	return sendMouseInput(mi)
}

func injectMouseButton(button int32, down bool) error {
	var flag uint32
	switch button {
	case 0:
		if down {
			flag = mouseeventfLeftDown
		} else {
			flag = mouseeventfLeftUp
		}
	case 1:
		if down {
			flag = mouseeventfMiddleDown
		} else {
			flag = mouseeventfMiddleUp
		}
	case 2:
		if down {
			flag = mouseeventfRightDown
		} else {
			flag = mouseeventfRightUp
		}
	default:
		return fmt.Errorf("unsupported mouse button: %d", button)
	}

	mi := mouseInput{DwFlags: flag}
	return sendMouseInput(mi)
}

func injectMouseScroll(deltaY float64) error {
	wheelDelta := int32(math.Round(deltaY * -120.0 / 50.0))
	if wheelDelta == 0 {
		return nil
	}

	mi := mouseInput{
		MouseData: uint32(int32(wheelDelta)),
		DwFlags:   mouseeventfWheel,
	}

	return sendMouseInput(mi)
}

func injectKeyboard(code string, down bool) error {
	vk, ok := keyMap[code]
	if !ok {
		return fmt.Errorf("unsupported key code: %s", code)
	}

	flags := uint32(0)
	if !down {
		flags = keyeventfKeyUp
	}

	ki := keyboardInput{
		WVKey:   vk,
		DwFlags: flags,
	}

	return sendKeyboardInput(ki)
}

func sendMouseInput(mi mouseInput) error {
	in := input{Type: inputMouse}
	in.Iu.Mi = mi
	return sendInput([]input{in})
}

func sendKeyboardInput(ki keyboardInput) error {
	in := input{Type: inputKeyboard}
	in.Iu.Ki = ki
	return sendInput([]input{in})
}

func sendInput(inputs []input) error {
	if len(inputs) == 0 {
		return nil
	}

	ret, _, err := procSendInput.Call(
		uintptr(len(inputs)),
		uintptr(unsafe.Pointer(&inputs[0])),
		unsafe.Sizeof(inputs[0]),
	)
	if ret == 0 {
		if err != syscall.Errno(0) {
			return err
		}
		return errors.New("SendInput returned 0")
	}
	return nil
}

func getSystemMetric(index int32) int32 {
	ret, _, _ := procGetMetrics.Call(uintptr(index))
	return int32(ret)
}

func clamp(v, min, max float64) float64 {
	if v < min {
		return min
	}
	if v > max {
		return max
	}
	return v
}

var keyMap = map[string]uint16{
	"Backspace":   0x08,
	"Tab":         0x09,
	"Enter":       0x0D,
	"ShiftLeft":   0xA0,
	"ShiftRight":  0xA1,
	"ControlLeft": 0xA2,
	"ControlRight": 0xA3,
	"AltLeft":     0xA4,
	"AltRight":    0xA5,
	"Pause":       0x13,
	"CapsLock":    0x14,
	"Escape":      0x1B,
	"Space":       0x20,
	"PageUp":      0x21,
	"PageDown":    0x22,
	"End":         0x23,
	"Home":        0x24,
	"ArrowLeft":   0x25,
	"ArrowUp":     0x26,
	"ArrowRight":  0x27,
	"ArrowDown":   0x28,
	"Insert":      0x2D,
	"Delete":      0x2E,
	"Digit0":      0x30,
	"Digit1":      0x31,
	"Digit2":      0x32,
	"Digit3":      0x33,
	"Digit4":      0x34,
	"Digit5":      0x35,
	"Digit6":      0x36,
	"Digit7":      0x37,
	"Digit8":      0x38,
	"Digit9":      0x39,
	"KeyA":        0x41,
	"KeyB":        0x42,
	"KeyC":        0x43,
	"KeyD":        0x44,
	"KeyE":        0x45,
	"KeyF":        0x46,
	"KeyG":        0x47,
	"KeyH":        0x48,
	"KeyI":        0x49,
	"KeyJ":        0x4A,
	"KeyK":        0x4B,
	"KeyL":        0x4C,
	"KeyM":        0x4D,
	"KeyN":        0x4E,
	"KeyO":        0x4F,
	"KeyP":        0x50,
	"KeyQ":        0x51,
	"KeyR":        0x52,
	"KeyS":        0x53,
	"KeyT":        0x54,
	"KeyU":        0x55,
	"KeyV":        0x56,
	"KeyW":        0x57,
	"KeyX":        0x58,
	"KeyY":        0x59,
	"KeyZ":        0x5A,
	"MetaLeft":    0x5B,
	"MetaRight":   0x5C,
	"Numpad0":     0x60,
	"Numpad1":     0x61,
	"Numpad2":     0x62,
	"Numpad3":     0x63,
	"Numpad4":     0x64,
	"Numpad5":     0x65,
	"Numpad6":     0x66,
	"Numpad7":     0x67,
	"Numpad8":     0x68,
	"Numpad9":     0x69,
	"NumpadMultiply": 0x6A,
	"NumpadAdd":      0x6B,
	"NumpadSubtract": 0x6D,
	"NumpadDecimal":  0x6E,
	"NumpadDivide":   0x6F,
	"F1":             0x70,
	"F2":             0x71,
	"F3":             0x72,
	"F4":             0x73,
	"F5":             0x74,
	"F6":             0x75,
	"F7":             0x76,
	"F8":             0x77,
	"F9":             0x78,
	"F10":            0x79,
	"F11":            0x7A,
	"F12":            0x7B,
}
