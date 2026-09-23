// TerminalMCP playtest bridge for Unity.
//
// Add this component to the player GameObject of a test scene and press Play.
// It listens on 127.0.0.1:8080; start the playtest from TerminalMCP with
//     laya { action: "playtest", bridge: 8080, actions: [...], ... }
//
// Protocol, one JSON object per line: the bridge sends the state, reads one
// action back, applies it for `holdSeconds` of game time, then sends the next
// state. Actions: move_forward, move_back, move_left, move_right, turn_left,
// turn_right, turn_around, jump, wait.
//
// Unlike a bridge that reads transform.position from its socket thread (which
// Unity refuses: its API is main-thread only), the socket thread here only
// moves strings; every Unity call happens in Update.

using System;
using System.Collections.Concurrent;
using System.IO;
using System.Net;
using System.Net.Sockets;
using System.Text;
using System.Threading;
using UnityEngine;

public class TerminalMcpBridge : MonoBehaviour
{
    public int port = 8080;
    public float holdSeconds = 0.25f;
    public float moveSpeed = 4f;
    public float jumpSpeed = 5f;
    public float turnDegrees = 30f;
    public float wallProbe = 1.2f;

    CharacterController controller;
    Rigidbody body;

    readonly ConcurrentQueue<string> inbox = new ConcurrentQueue<string>();
    readonly ConcurrentQueue<string> outbox = new ConcurrentQueue<string>();
    readonly AutoResetEvent outboxSignal = new AutoResetEvent(false);
    Thread netThread;
    volatile bool running;
    volatile bool connected;
    TcpListener listener;

    bool awaiting;
    string current;
    float holdLeft;
    Vector3 velocity;

    // Written from any thread by Unity's log callback, read in Update.
    volatile bool hadError;
    volatile string lastError = "";

    void OnEnable()
    {
        Application.logMessageReceivedThreaded += OnLog;
        running = true;
        netThread = new Thread(Serve) { IsBackground = true, Name = "TerminalMCP bridge" };
        netThread.Start();
    }

    void OnDisable()
    {
        Application.logMessageReceivedThreaded -= OnLog;
        running = false;
        try { listener?.Stop(); } catch { }
        outboxSignal.Set();
    }

    void Start()
    {
        controller = GetComponent<CharacterController>();
        body = GetComponent<Rigidbody>();
    }

    void OnLog(string message, string stackTrace, LogType type)
    {
        if (type == LogType.Error || type == LogType.Exception || type == LogType.Assert)
        {
            lastError = message + (string.IsNullOrEmpty(stackTrace) ? "" : " | " + stackTrace.Split('\n')[0]);
            hadError = true;
        }
    }

    // ---- network thread: strings in, strings out, nothing else ----

    void Serve()
    {
        try
        {
            listener = new TcpListener(IPAddress.Loopback, port);
            listener.Start();
            Debug.Log("[TerminalMCP bridge] listening on 127.0.0.1:" + port);
            while (running)
            {
                using (var client = listener.AcceptTcpClient())
                {
                    client.NoDelay = true;
                    var stream = client.GetStream();
                    var reader = new StreamReader(stream, new UTF8Encoding(false));
                    var writer = new StreamWriter(stream, new UTF8Encoding(false)) { AutoFlush = true, NewLine = "\n" };
                    connected = true;
                    var readThread = new Thread(() =>
                    {
                        try
                        {
                            string line;
                            while ((line = reader.ReadLine()) != null) inbox.Enqueue(line);
                        }
                        catch { }
                        connected = false;
                        outboxSignal.Set();
                    }) { IsBackground = true };
                    readThread.Start();
                    while (running && connected)
                    {
                        outboxSignal.WaitOne(250);
                        while (outbox.TryDequeue(out var msg)) writer.WriteLine(msg);
                    }
                    connected = false;
                }
            }
        }
        catch (Exception e)
        {
            if (running) Debug.LogWarning("[TerminalMCP bridge] stopped: " + e.Message);
        }
    }

    // ---- main thread: all Unity calls ----

    void Update()
    {
        if (!connected) { awaiting = false; current = null; return; }

        while (inbox.TryDequeue(out var line))
        {
            awaiting = false;
            StartAction(ParseAction(line));
        }

        if (current != null)
        {
            ContinueAction(Time.deltaTime);
            holdLeft -= Time.deltaTime;
            if (holdLeft <= 0) current = null;
        }
        ApplyGravity(Time.deltaTime);

        if (current == null && !awaiting)
        {
            outbox.Enqueue(StateJson());
            outboxSignal.Set();
            awaiting = true;
        }
    }

    static string ParseAction(string line)
    {
        // {"action":"move_forward"} without a JSON library dependency.
        int k = line.IndexOf("\"action\"", StringComparison.Ordinal);
        if (k < 0) return line.Trim();
        int q1 = line.IndexOf('"', line.IndexOf(':', k) + 1);
        int q2 = q1 >= 0 ? line.IndexOf('"', q1 + 1) : -1;
        return q1 >= 0 && q2 > q1 ? line.Substring(q1 + 1, q2 - q1 - 1) : "";
    }

    void StartAction(string action)
    {
        current = action;
        holdLeft = holdSeconds;
        switch (action)
        {
            case "turn_left": transform.Rotate(0, -turnDegrees, 0); break;
            case "turn_right": transform.Rotate(0, turnDegrees, 0); break;
            case "turn_around": transform.Rotate(0, 180, 0); break;
            case "jump":
                if (Grounded())
                {
                    if (body != null && controller == null) body.AddForce(Vector3.up * jumpSpeed, ForceMode.VelocityChange);
                    else velocity.y = jumpSpeed;
                }
                break;
        }
    }

    void ContinueAction(float dt)
    {
        Vector3 dir = Vector3.zero;
        switch (current)
        {
            case "move_forward": dir = transform.forward; break;
            case "move_back": dir = -transform.forward; break;
            case "move_left": dir = -transform.right; break;
            case "move_right": dir = transform.right; break;
        }
        if (dir == Vector3.zero) return;
        Vector3 step = dir * moveSpeed * dt;
        if (controller != null) controller.Move(step);
        else if (body != null) body.MovePosition(body.position + step);
        else transform.position += step;
    }

    void ApplyGravity(float dt)
    {
        if (controller == null) return;
        if (controller.isGrounded && velocity.y < 0) velocity.y = -1f;
        velocity.y += Physics.gravity.y * dt;
        controller.Move(new Vector3(0, velocity.y, 0) * dt);
    }

    bool Grounded()
    {
        if (controller != null) return controller.isGrounded;
        return Physics.Raycast(transform.position + Vector3.up * 0.1f, Vector3.down, 0.3f);
    }

    string StateJson()
    {
        Vector3 p = transform.position;
        Vector3 v = controller != null ? controller.velocity : body != null ? body.velocity : Vector3.zero;
        bool wall = Physics.Raycast(transform.position + Vector3.up * 0.5f, transform.forward, wallProbe);
        bool err = hadError;
        string log = err ? lastError : "";
        hadError = false;
        var sb = new StringBuilder(256);
        sb.Append("{\"playing\":true");
        sb.Append(",\"pos\":[").Append(F(p.x)).Append(',').Append(F(p.y)).Append(',').Append(F(p.z)).Append(']');
        sb.Append(",\"speed\":").Append(F(v.magnitude));
        sb.Append(",\"yaw\":").Append(F(transform.eulerAngles.y));
        sb.Append(",\"grounded\":").Append(Grounded() ? "true" : "false");
        sb.Append(",\"wall_ahead\":").Append(wall ? "true" : "false");
        sb.Append(",\"scene\":\"").Append(Escape(UnityEngine.SceneManagement.SceneManager.GetActiveScene().name)).Append('"');
        sb.Append(",\"has_exception\":").Append(err ? "true" : "false");
        sb.Append(",\"last_log\":\"").Append(Escape(log)).Append("\"}");
        return sb.ToString();
    }

    static string F(float f) => f.ToString("0.###", System.Globalization.CultureInfo.InvariantCulture);

    static string Escape(string s)
    {
        if (string.IsNullOrEmpty(s)) return "";
        var sb = new StringBuilder(s.Length + 8);
        foreach (char c in s)
        {
            switch (c)
            {
                case '"': sb.Append("\\\""); break;
                case '\\': sb.Append("\\\\"); break;
                case '\n': sb.Append("\\n"); break;
                case '\r': break;
                case '\t': sb.Append("\\t"); break;
                default: if (c < 0x20) sb.Append(' '); else sb.Append(c); break;
            }
        }
        return sb.ToString();
    }
}
