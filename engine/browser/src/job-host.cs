// Windows Job Object Host for Course Factory P7.3.
// Canonical authority: docs/P7-DESIGN-SPEC.md Section 19.
//
// Manages a Windows Job Object configured with JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE (0x2000).
// When this supervisor exits or when the job handle closes, Windows kernel guarantees
// that all assigned Chromium processes and their child processes are automatically terminated.
//
// Commands accepted over stdin:
//   CREATE [jobName]   - Creates Job Object with KILL_ON_JOB_CLOSE limit. Returns "OK" or "ERR ...".
//   ASSIGN <pid>       - Assigns target process to the Job Object. Returns "OK" or "ERR ...".
//   QUERY_PIDS         - Queries all PIDs in the Job Object. Returns "OK <pid1>,<pid2>..." or "ERR ...".
//   TERMINATE          - Explicitly terminates all processes in the Job Object. Returns "OK".
//   CLOSE              - Closes job handle and exits. Returns "OK".

using System;
using System.IO;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Diagnostics;

class Program {
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern IntPtr CreateJobObject(IntPtr lpJobAttributes, string lpName);

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool SetInformationJobObject(IntPtr hJob, int JobObjectInfoClass, IntPtr lpJobObjectInfo, uint cbJobObjectInfoLength);

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool AssignProcessToJobObject(IntPtr hJob, IntPtr hProcess);

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool TerminateJobObject(IntPtr hJob, uint uExitCode);

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool CloseHandle(IntPtr hObject);

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern IntPtr OpenProcess(uint processAccess, bool bInheritHandle, int processId);

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool QueryInformationJobObject(IntPtr hJob, int JobObjectInformationClass, IntPtr lpJobObjectInformation, uint cbJobObjectInformationLength, out uint lpReturnLength);

    const int JobObjectExtendedLimitInformation = 9;
    const int JobObjectBasicProcessIdList = 3;
    const uint JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x2000;
    const uint PROCESS_SET_QUOTA = 0x0100;
    const uint PROCESS_TERMINATE = 0x0001;

    [StructLayout(LayoutKind.Sequential)]
    struct IO_COUNTERS {
        public ulong ReadOperationCount;
        public ulong WriteOperationCount;
        public ulong OtherOperationCount;
        public ulong ReadTransferCount;
        public ulong WriteTransferCount;
        public ulong OtherTransferCount;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct JOBOBJECT_BASIC_LIMIT_INFORMATION {
        public long PerProcessUserTimeLimit;
        public long PerJobUserTimeLimit;
        public uint LimitFlags;
        public UIntPtr MinimumWorkingSetSize;
        public UIntPtr MaximumWorkingSetSize;
        public uint ActiveProcessLimit;
        public UIntPtr Affinity;
        public uint PriorityClass;
        public uint SchedulingClass;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION {
        public JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation;
        public IO_COUNTERS IoInfo;
        public UIntPtr ProcessMemoryLimit;
        public UIntPtr JobMemoryLimit;
        public UIntPtr PeakProcessMemoryLimit;
        public UIntPtr PeakJobMemoryLimit;
    }

    static void Main(string[] args) {
        Console.OutputEncoding = System.Text.Encoding.UTF8;
        IntPtr hJob = IntPtr.Zero;
        string line;

        try {
            while ((line = Console.ReadLine()) != null) {
                line = line.Trim();
                if (string.IsNullOrEmpty(line)) continue;

                string[] parts = line.Split(new char[] { ' ' }, 2);
                string cmd = parts[0].ToUpperInvariant();
                string arg = parts.Length > 1 ? parts[1] : "";

                if (cmd == "CREATE") {
                    string jobName = string.IsNullOrEmpty(arg) ? null : arg;
                    hJob = CreateJobObject(IntPtr.Zero, jobName);
                    if (hJob == IntPtr.Zero) {
                        Console.WriteLine("ERR " + Marshal.GetLastWin32Error());
                        continue;
                    }
                    var info = new JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
                    info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
                    int length = Marshal.SizeOf(typeof(JOBOBJECT_EXTENDED_LIMIT_INFORMATION));
                    IntPtr pInfo = Marshal.AllocHGlobal(length);
                    try {
                        Marshal.StructureToPtr(info, pInfo, false);
                        if (!SetInformationJobObject(hJob, JobObjectExtendedLimitInformation, pInfo, (uint)length)) {
                            Console.WriteLine("ERR " + Marshal.GetLastWin32Error());
                            continue;
                        }
                    } finally {
                        Marshal.FreeHGlobal(pInfo);
                    }
                    Console.WriteLine("OK");
                }
                else if (cmd == "ASSIGN") {
                    if (hJob == IntPtr.Zero) {
                        Console.WriteLine("ERR NO_JOB");
                        continue;
                    }
                    int pid;
                    if (!int.TryParse(arg, out pid)) {
                        Console.WriteLine("ERR INVALID_PID");
                        continue;
                    }
                    IntPtr hProc = OpenProcess(PROCESS_SET_QUOTA | PROCESS_TERMINATE, false, pid);
                    if (hProc == IntPtr.Zero) {
                        Console.WriteLine("ERR OPEN_PROCESS_" + Marshal.GetLastWin32Error());
                        continue;
                    }
                    try {
                        if (!AssignProcessToJobObject(hJob, hProc)) {
                            Console.WriteLine("ERR ASSIGN_" + Marshal.GetLastWin32Error());
                        } else {
                            Console.WriteLine("OK");
                        }
                    } finally {
                        CloseHandle(hProc);
                    }
                }
                else if (cmd == "QUERY_PIDS") {
                    if (hJob == IntPtr.Zero) {
                        Console.WriteLine("ERR NO_JOB");
                        continue;
                    }
                    uint bufSize = 8192;
                    IntPtr pBuf = Marshal.AllocHGlobal((int)bufSize);
                    try {
                        uint retLen;
                        if (!QueryInformationJobObject(hJob, JobObjectBasicProcessIdList, pBuf, bufSize, out retLen)) {
                            Console.WriteLine("ERR QUERY_" + Marshal.GetLastWin32Error());
                            continue;
                        }
                        int count = Marshal.ReadInt32(pBuf, 4);
                        List<int> pids = new List<int>();
                        int ptrSize = IntPtr.Size;
                        for (int i = 0; i < count; i++) {
                            IntPtr pidVal = Marshal.ReadIntPtr(pBuf, 8 + i * ptrSize);
                            pids.Add((int)pidVal);
                        }
                        Console.WriteLine("OK " + string.Join(",", pids.ConvertAll(p => p.ToString()).ToArray()));
                    } finally {
                        Marshal.FreeHGlobal(pBuf);
                    }
                }
                else if (cmd == "TERMINATE") {
                    if (hJob == IntPtr.Zero) {
                        Console.WriteLine("OK");
                        continue;
                    }
                    TerminateJobObject(hJob, 1);
                    Console.WriteLine("OK");
                }
                else if (cmd == "CLOSE") {
                    if (hJob != IntPtr.Zero) {
                        CloseHandle(hJob);
                        hJob = IntPtr.Zero;
                    }
                    Console.WriteLine("OK");
                    break;
                }
                else {
                    Console.WriteLine("ERR UNKNOWN_CMD");
                }
            }
        } finally {
            if (hJob != IntPtr.Zero) {
                CloseHandle(hJob);
            }
        }
    }
}
