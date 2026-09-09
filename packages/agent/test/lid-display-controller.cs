using System;
using MrRobot.LidDisplay;
public sealed class FakeDisplay : IDisplay {
  public int Captures, Disconnections, Restores, Saves, Clears;
  public bool External = true, FailDisconnect, FailRestore;
  public Snapshot Current = new Snapshot(), Restored;
  public Snapshot Capture() { Captures++; return Current; }
  public bool HasExternal(Snapshot s) { return External; }
  public void Save(Snapshot s) { Saves++; }
  public void DisconnectExternal() { Disconnections++; if (FailDisconnect) throw new Exception("fixture disconnect"); }
  public void Restore(Snapshot s) { Restores++; if (FailRestore) throw new Exception("fixture restore"); Restored = s; }
  public void Clear() { Clears++; }
}
public static class LidTests {
  static void Check(bool condition) { if (!condition) throw new Exception("Lid controller regression"); }
  public static void Run() {
    var d = new FakeDisplay(); var c = new Controller(d);
    c.Lid(false); Check(d.Disconnections == 0); // Enabled while closed is safe.
    c.Lid(true); var original = d.Current;
    c.Lid(false); c.Lid(false); Check(d.Disconnections == 1 && d.Saves == 1);
    d.Current = new Snapshot(); c.DisplayChanged(); // Windows topology event cannot replace saved layout.
    c.Lid(true); Check(d.Restored == original && c.Saved == null && d.Clears == 1);
    c.DisplayChanged(); c.Lid(false); c.Restore(); Check(d.Restored == d.Current);
    int changes = d.Disconnections; c.Lid(false); Check(changes == d.Disconnections); // Manual restore doesn't immediately disconnect again.
    c.Lid(true); d.External = false; c.Lid(false); Check(d.Disconnections == changes);
    d.External = true; c.Lid(true); d.FailDisconnect = true;
    try { c.Lid(false); throw new Exception("expected failure"); } catch (Exception e) { Check(e.Message == "fixture disconnect"); }
    Check(c.Saved == null); // Partial apply failure triggers restore.
    d.FailDisconnect = false; c.Lid(true); c.Lid(false); d.FailRestore = true;
    try { c.Restore(); throw new Exception("expected failure"); } catch (Exception e) { Check(e.Message == "fixture restore"); }
    Check(c.Saved != null); d.FailRestore = false; c.Restore(); Check(c.Saved == null);
    var recovered = new Snapshot(); c.Recover(recovered); Check(d.Restored == recovered);
    Console.WriteLine("Lid controller passed: initial closed, duplicate events, snapshot restoration, manual restore, absent external, partial failures, crash recovery.");
  }
}
