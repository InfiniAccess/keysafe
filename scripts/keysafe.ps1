# Keysafe's Windows backend: Windows Credential Manager through advapi32.
#   get NAME          print the value (exit 1 when missing)
#   set NAME          store stdin as the value (exit 3 when NAME exists: never overwrites)
#   del NAME          delete it
#   env NAME...       print `export NAME='value'` lines for a POSIX shell to eval
param([Parameter(Mandatory = $true)][string]$Op, [Parameter(ValueFromRemainingArguments = $true)][string[]]$Names)
$ErrorActionPreference = 'Stop'

Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class KeysafeCred {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  struct CREDENTIAL {
    public int Flags; public int Type; public string TargetName; public string Comment;
    public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten;
    public int CredentialBlobSize; public IntPtr CredentialBlob; public int Persist;
    public int AttributeCount; public IntPtr Attributes; public string TargetAlias; public string UserName;
  }
  [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  static extern bool CredReadW(string target, int type, int flags, out IntPtr cred);
  [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  static extern bool CredWriteW(ref CREDENTIAL cred, int flags);
  [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  static extern bool CredDeleteW(string target, int type, int flags);
  [DllImport("advapi32.dll")]
  static extern void CredFree(IntPtr cred);
  const int GENERIC = 1;
  const int PERSIST_LOCAL_MACHINE = 2;
  public static string Read(string target) {
    IntPtr p;
    if (!CredReadW(target, GENERIC, 0, out p)) return null;
    try {
      CREDENTIAL c = (CREDENTIAL)Marshal.PtrToStructure(p, typeof(CREDENTIAL));
      return Marshal.PtrToStringUni(c.CredentialBlob, c.CredentialBlobSize / 2);
    } finally { CredFree(p); }
  }
  public static bool Write(string target, string user, string secret) {
    byte[] blob = Encoding.Unicode.GetBytes(secret);
    CREDENTIAL c = new CREDENTIAL();
    c.Type = GENERIC; c.TargetName = target; c.UserName = user; c.Persist = PERSIST_LOCAL_MACHINE;
    c.CredentialBlobSize = blob.Length; c.CredentialBlob = Marshal.AllocHGlobal(blob.Length);
    try { Marshal.Copy(blob, 0, c.CredentialBlob, blob.Length); return CredWriteW(ref c, 0); }
    finally { Marshal.FreeHGlobal(c.CredentialBlob); }
  }
  public static bool Delete(string target) { return CredDeleteW(target, GENERIC, 0); }
}
"@

function Target([string]$name) { "claude-keysafe:$name" }
function Check([string]$name) { if ($name -notmatch '^[A-Z_][A-Z0-9_]*$') { [Console]::Error.WriteLine("bad name: $name"); exit 2 } }

switch ($Op) {
  'get' {
    Check $Names[0]
    $v = [KeysafeCred]::Read((Target $Names[0]))
    if ($null -eq $v) { exit 1 }
    [Console]::Out.Write($v); exit 0
  }
  'set' {
    Check $Names[0]
    if ($null -ne [KeysafeCred]::Read((Target $Names[0]))) { [Console]::Error.WriteLine('exists'); exit 3 }
    $v = [Console]::In.ReadToEnd()
    if ([string]::IsNullOrEmpty($v)) { exit 4 }
    if ([KeysafeCred]::Write((Target $Names[0]), $Names[0], $v)) { exit 0 } else { exit 1 }
  }
  'del' {
    Check $Names[0]
    [void][KeysafeCred]::Delete((Target $Names[0])); exit 0
  }
  'env' {
    $out = New-Object System.Text.StringBuilder
    foreach ($n in $Names) {
      Check $n
      $v = [KeysafeCred]::Read((Target $n))
      if ($null -ne $v) { [void]$out.Append("export $n='" + $v.Replace("'", "'\''") + "'`n") }
    }
    [Console]::Out.Write($out.ToString()); exit 0
  }
  default { [Console]::Error.WriteLine("unknown op: $Op"); exit 2 }
}
