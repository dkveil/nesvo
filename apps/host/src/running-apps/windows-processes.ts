export const WINDOWS_PROCESS_SNAPSHOT = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.Encoding]::UTF8
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;

public static class NesvoProcesses {
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct Entry {
        public uint Size, Usage, Pid;
        public UIntPtr Heap;
        public uint Module, Threads, Parent;
        public int Priority;
        public uint Flags;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)]
        public string Name;
    }

    private sealed class Snapshot : SafeHandleZeroOrMinusOneIsInvalid {
        private Snapshot() : base(true) {}
        [DllImport("kernel32.dll")]
        private static extern bool CloseHandle(IntPtr handle);
        protected override bool ReleaseHandle() { return CloseHandle(handle); }
    }

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern Snapshot CreateToolhelp32Snapshot(uint flags, uint pid);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool Process32First(Snapshot snapshot, ref Entry entry);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool Process32Next(Snapshot snapshot, ref Entry entry);

    public sealed class ProcessEntry {
        public uint pid, parent;
        public string name;
        public long? startedAt;
    }

    public static List<ProcessEntry> Read(uint[] listeners) {
        var processes = new Dictionary<uint, ProcessEntry>();
        using (var snapshot = CreateToolhelp32Snapshot(2, 0)) {
            var entry = new Entry { Size = (uint)Marshal.SizeOf(typeof(Entry)) };
            if (snapshot.IsInvalid || !Process32First(snapshot, ref entry))
                throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
            do {
                processes[entry.Pid] = new ProcessEntry {
                    pid = entry.Pid, parent = entry.Parent, name = entry.Name
                };
            } while (Process32Next(snapshot, ref entry));
        }
        var visited = new HashSet<uint>();
        var owners = new List<ProcessEntry>();
        foreach (var listener in listeners) {
            uint pid = listener;
            ProcessEntry entry;
            for (int depth = 0; depth < 32 && pid != 0 &&
                 processes.TryGetValue(pid, out entry); depth++) {
                if (visited.Add(pid)) {
                    try {
                        using (var process = Process.GetProcessById((int)pid))
                            entry.startedAt = new DateTimeOffset(process.StartTime).ToUnixTimeMilliseconds();
                    } catch (ArgumentException) {
                    } catch (InvalidOperationException) {
                    } catch (System.ComponentModel.Win32Exception) {
                    }
                    owners.Add(entry);
                }
                pid = entry.parent;
            }
        }
        return owners;
    }
}
'@
$listeners = [Console]::ReadLine().Split(',') | ForEach-Object { [uint32]$_ }
ConvertTo-Json -InputObject @([NesvoProcesses]::Read([uint32[]]$listeners).ToArray()) -Compress
`;
