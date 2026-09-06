package com.mrrobot.mobile;

import android.app.Activity;
import android.app.Instrumentation;
import android.content.Intent;
import android.graphics.Rect;
import android.os.Bundle;
import android.view.View;
import android.view.ViewGroup;
import android.view.WindowInsets;
import android.view.inputmethod.InputMethodManager;
import android.widget.EditText;
import java.io.FileOutputStream;

/** Device-level regression audit of the actual RN screen and Android IME. */
public class KeyboardAudit extends Instrumentation {
    private Activity activity;
    private EditText input;
    private boolean landscape;
    private final StringBuilder evidence = new StringBuilder();
    public void onCreate(Bundle args) { super.onCreate(args); landscape = "landscape".equals(args.getString("orientation")); start(); }
    private View findSend(View v) {
        CharSequence label = v.getContentDescription() == null ? "" : v.getContentDescription();
        if ("명령 보내기".contentEquals(label) || "실행 중인 작업 중지".contentEquals(label)) return v;
        if (v instanceof ViewGroup) for (int i = 0; i < ((ViewGroup) v).getChildCount(); i++) {
            View found = findSend(((ViewGroup) v).getChildAt(i)); if (found != null) return found;
        }
        return null;
    }
    private EditText findInput(View v) {
        if (v instanceof EditText) return (EditText) v;
        if (v instanceof ViewGroup) for (int i = 0; i < ((ViewGroup) v).getChildCount(); i++) {
            EditText found = findInput(((ViewGroup) v).getChildAt(i));
            if (found != null) return found;
        }
        return null;
    }
    private void pause(long ms) { try { Thread.sleep(ms); } catch (InterruptedException e) { throw new RuntimeException(e); } }
    private int imeBottom() {
        final int[] result = {0};
        runOnMainSync(() -> { WindowInsets insets = activity.getWindow().getDecorView().getRootWindowInsets(); result[0] = insets == null ? 0 : insets.getInsets(WindowInsets.Type.ime()).bottom; });
        return result[0];
    }
    private void verify(String stage) {
        final String[] failure = {null};
        runOnMainSync(() -> {
            Rect visible = new Rect(); input.getGlobalVisibleRect(visible);
            int keyboardTop = activity.getWindowManager().getCurrentWindowMetrics().getBounds().bottom - activity.getWindow().getDecorView().getRootWindowInsets().getInsets(WindowInsets.Type.ime()).bottom;
            int[] at = new int[2]; input.getLocationOnScreen(at);
            evidence.append(stage).append(": input=").append(at[1]).append("..").append(at[1]+input.getHeight()).append(" keyboardTop=").append(keyboardTop).append(" visible=").append(visible).append('\n');
            if (at[1] + input.getHeight() > keyboardTop + 2 || visible.height() < 30) failure[0] = stage + ": input obscured by keyboard";
            if (input.getLayout() != null) {
                int line = input.getLayout().getLineForOffset(input.getSelectionEnd());
                int cursorBottom = at[1] + input.getTotalPaddingTop() + input.getLayout().getLineBottom(line) - input.getScrollY();
                if (cursorBottom > keyboardTop + 2 || cursorBottom > visible.bottom + 2) failure[0] = stage + ": insertion cursor clipped";
            }
            View send = findSend(activity.getWindow().getDecorView());
            if (send == null) failure[0] = stage + ": send control missing";
            else {
                int[] sendAt = new int[2]; send.getLocationOnScreen(sendAt);
                Rect sendVisible = new Rect(); send.getGlobalVisibleRect(sendVisible);
                evidence.append("send=").append(sendAt[0]).append(",").append(sendAt[1]).append("..").append(sendAt[1] + send.getHeight()).append('\n');
                int screenRight = activity.getWindowManager().getCurrentWindowMetrics().getBounds().right;
                if (sendAt[0] < 0 || sendAt[0] + send.getWidth() > screenRight || sendAt[1] + send.getHeight() > keyboardTop + 2 || sendVisible.height() < send.getHeight() - 2 || sendVisible.width() < send.getWidth() - 2) failure[0] = stage + ": send control clipped";
            }
        });
        if (failure[0] != null) throw new AssertionError(failure[0]);
    }
    public void onStart() {
        Bundle result = new Bundle();
        try {
            if (!getTargetContext().getPackageName().endsWith(".uitest")) throw new SecurityException("Only the separate UI test application is allowed");
            Intent intent = new Intent().setClassName(getTargetContext(), "com.mrrobot.mobile.MainActivity").addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            activity = startActivitySync(intent);
            for (int i = 0; i < 100 && input == null; i++) { runOnMainSync(() -> input = findInput(activity.getWindow().getDecorView())); pause(200); }
            if (input == null) throw new AssertionError("React Native composer did not load");
            runOnMainSync(() -> activity.setRequestedOrientation(landscape ? android.content.pm.ActivityInfo.SCREEN_ORIENTATION_LANDSCAPE : android.content.pm.ActivityInfo.SCREEN_ORIENTATION_PORTRAIT));
            pause(1500);
            evidence.append("orientation=").append(landscape ? "landscape" : "portrait").append(" fontScale=").append(activity.getResources().getConfiguration().fontScale).append('\n');
            for (int cycle = 0; cycle < 3; cycle++) {
                runOnMainSync(() -> { input.requestFocus(); ((InputMethodManager) activity.getSystemService(Activity.INPUT_METHOD_SERVICE)).showSoftInput(input, InputMethodManager.SHOW_IMPLICIT); });
                for (int i = 0; i < 30 && imeBottom() == 0; i++) pause(100);
                if (imeBottom() == 0) throw new AssertionError("Real Android keyboard did not open");
                runOnMainSync(() -> { input.setText("Native keyboard audit\nLine 2\nLine 3\nLine 4\nLine 5\nLine 6\nLine 7\nCURSOR MUST BE VISIBLE"); input.setSelection(input.length()); });
                pause(800); verify("open-" + cycle); pause(800); verify("stable-" + cycle);
                if (cycle == 0) {
                    try (FileOutputStream out = new FileOutputStream(new java.io.File(getTargetContext().getExternalFilesDir(null), "keyboard-audit.png"))) { getUiAutomation().takeScreenshot().compress(android.graphics.Bitmap.CompressFormat.PNG, 100, out); }
                }
                runOnMainSync(() -> ((InputMethodManager) activity.getSystemService(Activity.INPUT_METHOD_SERVICE)).hideSoftInputFromWindow(input.getWindowToken(), 0));
                for (int i = 0; i < 30 && imeBottom() != 0; i++) pause(100);
                pause(500);
            }
            result.putString("stream", "NATIVE KEYBOARD AUDIT PASSED\n" + evidence); finish(Activity.RESULT_OK, result);
        } catch (Throwable error) {
            result.putString("stream", "NATIVE KEYBOARD AUDIT FAILED: " + error + "\n" + evidence); finish(Activity.RESULT_CANCELED, result);
        }
    }
}
