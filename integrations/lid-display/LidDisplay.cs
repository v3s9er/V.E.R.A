// First-party Windows display helper. No network, elevation, shell commands or
// power-plan writes. Display configuration is temporary (no SAVE_TO_DATABASE).
using System;
using System.IO;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Runtime.Serialization;
using System.Runtime.Serialization.Json;
using System.Threading;
using System.Windows.Forms;

namespace MrRobot.LidDisplay {
  [DataContract] public sealed class Snapshot {
    [DataMember] public byte[] Paths;
    [DataMember] public byte[] Modes;
    [DataMember] public uint PathCount;
    [DataMember] public uint ModeCount;
  }
  public interface IDisplay {
    Snapshot Capture();
    bool HasExternal(Snapshot snapshot);
    void Save(Snapshot snapshot);
    void DisconnectExternal();
    void Restore(Snapshot snapshot);
    void Clear();
  }
  // Testable policy; no display changes until an OPEN -> CLOSED transition.
  public sealed class Controller {
    readonly IDisplay display;
    public bool? Open { get; private set; }
    public Snapshot Saved { get; private set; }
    Snapshot lastOpen;
    public Controller(IDisplay backend) { display = backend; }
    public void Lid(bool open) {
      if (Open == open) { if (open && Saved != null) Restore(); return; }
      bool wasOpen = Open == true;
      Open = open;
      if (open) { Restore(); lastOpen = display.Capture(); return; }
      if (!wasOpen) return;
      Snapshot snapshot = lastOpen ?? display.Capture();
      if (!display.HasExternal(snapshot)) return;
      // Keep recovery state even if the driver changes partially and reports error.
      display.Save(snapshot); Saved = snapshot;
      try { display.DisconnectExternal(); }
      catch { Restore(); throw; }
    }
    public void DisplayChanged() {
      if (Open == true && Saved == null) lastOpen = display.Capture();
    }
    public void Restore() {
      if (Saved == null) return;
      display.Restore(Saved);
      display.Clear(); Saved = null;
    }
    public void Recover(Snapshot snapshot) { Saved = snapshot; Restore(); }
  }
  public sealed class NativeDisplay : IDisplay {
    [StructLayout(LayoutKind.Sequential)] struct Luid { public uint Low; public int High; }
    [StructLayout(LayoutKind.Sequential)] struct Source { public Luid Adapter; public uint Id, Mode, Status; }
    [StructLayout(LayoutKind.Sequential)] struct Rational { public uint Numerator, Denominator; }
    [StructLayout(LayoutKind.Sequential)] struct Target {
      public Luid Adapter; public uint Id, Mode, Technology, Rotation, Scaling;
      public Rational Refresh; public uint Scan; public int Available; public uint Status;
    }
    [StructLayout(LayoutKind.Sequential)] struct PathInfo { public Source Source; public Target Target; public uint Flags; }
    [DllImport("user32.dll")] static extern int GetDisplayConfigBufferSizes(uint flags, out uint paths, out uint modes);
    [DllImport("user32.dll")] static extern int QueryDisplayConfig(uint flags, ref uint paths, IntPtr pathArray, ref uint modes, IntPtr modeArray, IntPtr topology);
    [DllImport("user32.dll")] static extern int SetDisplayConfig(uint paths, IntPtr pathArray, uint modes, IntPtr modeArray, uint flags);
    readonly string statePath;
    const int PathSize = 72, ModeSize = 64;
    public NativeDisplay(string path) {
      if (Marshal.SizeOf(typeof(PathInfo)) != PathSize) throw new InvalidOperationException("Display ABI mismatch");
      statePath = path;
    }
    static bool Internal(uint technology) { return technology == 0x80000000 || technology == 6 || technology == 11 || technology == 13; }
    static PathInfo PathAt(Snapshot snapshot, int index) {
      var pin = GCHandle.Alloc(snapshot.Paths, GCHandleType.Pinned);
      try { return (PathInfo)Marshal.PtrToStructure(IntPtr.Add(pin.AddrOfPinnedObject(), index * PathSize), typeof(PathInfo)); }
      finally { pin.Free(); }
    }
    static void Check(int code) { if (code != 0) throw new InvalidOperationException("Windows display error " + code); }
    static void ValidateSnapshot(Snapshot snapshot) {
      if (snapshot == null || snapshot.PathCount < 1 || snapshot.PathCount > 128 || snapshot.ModeCount > 256 || snapshot.Paths == null || snapshot.Modes == null
        || snapshot.Paths.Length != snapshot.PathCount * PathSize || snapshot.Modes.Length != snapshot.ModeCount * ModeSize) throw new InvalidOperationException("Invalid display snapshot");
    }
    static Snapshot Query(uint flags) {
      for (int retry = 0; retry < 4; retry++) {
        uint p, m; Check(GetDisplayConfigBufferSizes(flags, out p, out m));
        if (p < 1 || p > 128 || m > 256) throw new InvalidOperationException("Unsupported display count");
        IntPtr paths = Marshal.AllocHGlobal((int)p * PathSize), modes = Marshal.AllocHGlobal(Math.Max(1, (int)m * ModeSize));
        try {
          int result = QueryDisplayConfig(flags, ref p, paths, ref m, modes, IntPtr.Zero);
          if (result == 122) continue;
          Check(result);
          var snapshot = new Snapshot { PathCount = p, ModeCount = m, Paths = new byte[p * PathSize], Modes = new byte[m * ModeSize] };
          Marshal.Copy(paths, snapshot.Paths, 0, snapshot.Paths.Length);
          Marshal.Copy(modes, snapshot.Modes, 0, snapshot.Modes.Length);
          return snapshot;
        } finally { Marshal.FreeHGlobal(paths); Marshal.FreeHGlobal(modes); }
      }
      throw new InvalidOperationException("Display configuration is changing");
    }
    static void Apply(Snapshot snapshot) {
      ValidateSnapshot(snapshot);
      var paths = GCHandle.Alloc(snapshot.Paths, GCHandleType.Pinned);
      var modes = GCHandle.Alloc(snapshot.Modes, GCHandleType.Pinned);
      try {
        IntPtr modePtr = snapshot.ModeCount == 0 ? IntPtr.Zero : modes.AddrOfPinnedObject();
        // Validate first; allow driver-specific mode adjustments, never persist.
        Check(SetDisplayConfig(snapshot.PathCount, paths.AddrOfPinnedObject(), snapshot.ModeCount, modePtr, 0x20 | 0x40 | 0x400));
        Check(SetDisplayConfig(snapshot.PathCount, paths.AddrOfPinnedObject(), snapshot.ModeCount, modePtr, 0x20 | 0x80 | 0x400));
      } finally { paths.Free(); modes.Free(); }
    }
    public Snapshot Capture() { return Query(2); }
    public bool HasExternal(Snapshot snapshot) {
      for (int i = 0; i < snapshot.PathCount; i++) if (!Internal(PathAt(snapshot, i).Target.Technology)) return true;
      return false;
    }
    public bool HasInternal() {
      var all = Query(1);
      for (int i = 0; i < all.PathCount; i++) if (Internal(PathAt(all, i).Target.Technology)) return true;
      return false;
    }
    public void DisconnectExternal() {
      var all = Query(1);
      for (int i = 0; i < all.PathCount; i++) {
        var path = PathAt(all, i);
        if (!Internal(path.Target.Technology)) continue;
        path.Source.Mode = uint.MaxValue; path.Target.Mode = uint.MaxValue; path.Flags = 1;
        var pin = GCHandle.Alloc(new byte[PathSize], GCHandleType.Pinned);
        try {
          Marshal.StructureToPtr(path, pin.AddrOfPinnedObject(), false);
          Apply(new Snapshot { Paths = (byte[])pin.Target, Modes = new byte[0], PathCount = 1 });
        } finally { pin.Free(); }
        return;
      }
      throw new InvalidOperationException("No internal laptop display detected");
    }
    public void Restore(Snapshot snapshot) {
      try { Apply(snapshot); }
      catch {
        // Cable/dock may have changed. Recover a usable connected topology.
        Check(SetDisplayConfig(0, IntPtr.Zero, 0, IntPtr.Zero, 0x80 | 0x0f));
      }
    }
    public void Save(Snapshot snapshot) {
      ValidateSnapshot(snapshot);
      Directory.CreateDirectory(Path.GetDirectoryName(statePath));
      var temp = statePath + ".tmp";
      using (var stream = new FileStream(temp, FileMode.Create, FileAccess.Write, FileShare.None)) {
        new DataContractJsonSerializer(typeof(Snapshot)).WriteObject(stream, snapshot); stream.Flush(true);
      }
      if (File.Exists(statePath)) File.Replace(temp, statePath, null); else File.Move(temp, statePath);
    }
    public Snapshot Load() {
      if (!File.Exists(statePath)) return null;
      if (new FileInfo(statePath).Length > 200000) throw new InvalidOperationException("Invalid recovery file");
      using (var stream = File.OpenRead(statePath)) {
        var saved = (Snapshot)new DataContractJsonSerializer(typeof(Snapshot)).ReadObject(stream);
        ValidateSnapshot(saved); return saved;
      }
    }
    public void Clear() { if (File.Exists(statePath)) File.Delete(statePath); }
  }
  sealed class Watcher : Form {
    [DllImport("user32.dll", SetLastError = true)] static extern IntPtr RegisterPowerSettingNotification(IntPtr recipient, ref Guid guid, uint flags);
    [DllImport("user32.dll")] static extern bool UnregisterPowerSettingNotification(IntPtr handle);
    readonly Guid lidGuid = new Guid("BA3E0F4D-B817-4094-A2D1-D56379E6A0F3");
    readonly Controller controller;
    readonly System.Windows.Forms.Timer timer;
    readonly Process parent;
    IntPtr notification;
    bool closing;
    DateTime changedAt;
    bool pendingDisplay;
    protected override void SetVisibleCore(bool value) { base.SetVisibleCore(false); }
    public Watcher(int parentId, string path) {
      ShowInTaskbar = false;
      parent = Process.GetProcessById(parentId);
      var display = new NativeDisplay(path); controller = new Controller(display);
      if (!display.HasInternal()) throw new InvalidOperationException("No internal laptop display detected");
      var saved = display.Load(); if (saved != null) controller.Recover(saved);
      Guid guid = lidGuid;
      notification = RegisterPowerSettingNotification(Handle, ref guid, 0);
      if (notification == IntPtr.Zero) throw new InvalidOperationException("Lid notification registration failed");
      timer = new System.Windows.Forms.Timer { Interval = 500 };
      timer.Tick += delegate {
        if (parent.HasExited) { Stop(); return; }
        if (pendingDisplay && (DateTime.UtcNow - changedAt).TotalMilliseconds > 700) {
          pendingDisplay = false;
          try { controller.DisplayChanged(); } catch (Exception error) { Program.Emit("error", error.Message); }
        }
      };
      timer.Start();
      var input = new Thread(delegate() {
        try {
          string line;
          while ((line = Console.ReadLine()) != null) {
            if (line == "restore") BeginInvoke((Action)delegate { try { controller.Restore(); Program.Emit("restored", "Manual restore"); } catch (Exception e) { Program.Emit("error", e.Message); } });
            if (line == "stop") break;
          }
          if (!IsDisposed) BeginInvoke((Action)Stop);
        } catch { /* Parent shutdown; timer is the independent fallback. */ }
      });
      input.IsBackground = true; input.Start();
      Program.Emit("ready", "Waiting for an open-to-closed lid transition");
    }
    protected override void WndProc(ref Message message) {
      if (message.Msg == 0x218 && message.WParam.ToInt64() == 0x8013 && message.LParam != IntPtr.Zero) {
        Guid guid = (Guid)Marshal.PtrToStructure(message.LParam, typeof(Guid));
        if (guid == lidGuid && Marshal.ReadInt32(message.LParam, 16) == 4) {
          int value = Marshal.ReadInt32(message.LParam, 20);
          if (value == 0 || value == 1) {
            try {
              controller.Lid(value == 1);
              Program.Emit(value == 1 ? "open" : controller.Saved != null ? "disconnected" : "closed", "");
            } catch (Exception error) { Program.Emit("error", error.Message); }
          }
        }
      }
      if (message.Msg == 0x7e) { pendingDisplay = true; changedAt = DateTime.UtcNow; }
      base.WndProc(ref message);
    }
    void Stop() { if (!closing) Close(); }
    protected override void OnFormClosing(FormClosingEventArgs e) {
      closing = true; timer.Stop();
      try { controller.Restore(); Program.Emit("stopped", "Display restored"); }
      catch (Exception error) { Program.Emit("error", error.Message); }
      if (notification != IntPtr.Zero) { UnregisterPowerSettingNotification(notification); notification = IntPtr.Zero; }
      timer.Dispose(); parent.Dispose();
      base.OnFormClosing(e);
    }
  }
  public static class Program {
    static string Esc(string text) { return text.Replace("\\", "\\\\").Replace("\"", "\\\"").Replace("\r", " ").Replace("\n", " "); }
    public static void Emit(string state, string detail) { Console.WriteLine("{\"state\":\"" + Esc(state) + "\",\"detail\":\"" + Esc(detail) + "\"}"); Console.Out.Flush(); }
    public static void Probe() {
      var display = new NativeDisplay(null); var snapshot = display.Capture();
      Console.WriteLine("{\"supported\":" + (display.HasInternal() ? "true" : "false") + ",\"activePaths\":" + snapshot.PathCount + ",\"external\":" + (display.HasExternal(snapshot) ? "true" : "false") + "}");
    }
    public static void Run(int parentId, string path) {
      bool owns = false;
      using (var mutex = new Mutex(false, "Local\\MrRobotLidDisplay-" + Process.GetCurrentProcess().SessionId)) {
        try {
          try { owns = mutex.WaitOne(0); } catch (AbandonedMutexException) { owns = true; }
          if (!owns) throw new InvalidOperationException("Lid display helper already running");
          using (var watcher = new Watcher(parentId, path)) Application.Run(watcher);
        } catch (Exception error) { Emit("error", error.Message); }
        finally { if (owns) mutex.ReleaseMutex(); }
      }
    }
  }
}
