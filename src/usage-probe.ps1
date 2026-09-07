# Read-only evidence collection. No execution of discovered app or uninstall strings.
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$warnings = New-Object 'System.Collections.Generic.List[string]'
$apps = New-Object 'System.Collections.Generic.List[object]'
$userAssist = New-Object 'System.Collections.Generic.List[object]'
$processPaths = New-Object 'System.Collections.Generic.List[string]'
$collectedAt = [DateTime]::UtcNow.ToString('o')
$knownFolders = @{}
$shortcutShell = $null

try {
    Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class SpaceLensKnownFolder {
    [DllImport("shell32.dll", CharSet = CharSet.Unicode)]
    private static extern int SHGetKnownFolderPath(ref Guid id, uint flags, IntPtr token, out IntPtr result);
    public static string Get(string value) {
        Guid id;
        if (!Guid.TryParse(value, out id)) return null;
        IntPtr buffer = IntPtr.Zero;
        try {
            // KF_FLAG_DONT_VERIFY: return configured path without filesystem I/O.
            int code = SHGetKnownFolderPath(ref id, 0x4000, IntPtr.Zero, out buffer);
            return code == 0 ? Marshal.PtrToStringUni(buffer) : null;
        } finally { if (buffer != IntPtr.Zero) Marshal.FreeCoTaskMem(buffer); }
    }
}
'@
} catch { $warnings.Add('Known folder resolution unavailable; unresolved records were skipped.') }

function Convert-Rot13([string]$value) {
    $characters = $value.ToCharArray()
    for ($index = 0; $index -lt $characters.Length; $index++) {
        $number = [int]$characters[$index]
        if ($number -ge 65 -and $number -le 90) { $characters[$index] = [char](65 + (($number - 65 + 13) % 26)) }
        elseif ($number -ge 97 -and $number -le 122) { $characters[$index] = [char](97 + (($number - 97 + 13) % 26)) }
    }
    return -join $characters
}

function Resolve-EvidencePath([string]$value) {
    if ([string]::IsNullOrWhiteSpace($value)) { return $null }
    $resolved = [Environment]::ExpandEnvironmentVariables($value.Trim().Trim('"'))
    $resolved = $resolved -replace '^UEME_RUNPATH:', ''
    if ($resolved -match '^(\{[0-9a-fA-F-]{36}\})(.*)$') {
        $folderId = $Matches[1]
        $tail = $Matches[2]
        if (-not $knownFolders.ContainsKey($folderId)) {
            try { $knownFolders[$folderId] = [SpaceLensKnownFolder]::Get($folderId) }
            catch { $knownFolders[$folderId] = $null }
        }
        if (-not $knownFolders[$folderId]) { return $null }
        $resolved = $knownFolders[$folderId].TrimEnd('\') + $tail
    }
    if ($resolved -notmatch '^[a-zA-Z]:[\\/]' -and $resolved -notmatch '^\\\\[^\\]+\\[^\\]+') { return $null }
    try { return [IO.Path]::GetFullPath($resolved) } catch { return $null }
}

$registryPath = 'Software\Microsoft\Windows\CurrentVersion\Uninstall'
foreach ($hive in @([Microsoft.Win32.RegistryHive]::LocalMachine, [Microsoft.Win32.RegistryHive]::CurrentUser)) {
    foreach ($view in @([Microsoft.Win32.RegistryView]::Registry64, [Microsoft.Win32.RegistryView]::Registry32)) {
        $baseKey = $null
        $uninstallKey = $null
        try {
            $baseKey = [Microsoft.Win32.RegistryKey]::OpenBaseKey($hive, $view)
            $uninstallKey = $baseKey.OpenSubKey($registryPath, $false)
            if ($null -eq $uninstallKey) { continue }
            foreach ($subkeyName in $uninstallKey.GetSubKeyNames()) {
                $appKey = $null
                try {
                    $appKey = $uninstallKey.OpenSubKey($subkeyName, $false)
                    if ($null -eq $appKey) { continue }
                    $displayName = [string]$appKey.GetValue('DisplayName', '')
                    if ([string]::IsNullOrWhiteSpace($displayName)) { continue }
                    $installLocation = Resolve-EvidencePath ([string]$appKey.GetValue('InstallLocation', ''))
                    $executable = $null
                    $icon = [string]$appKey.GetValue('DisplayIcon', '')
                    if ($icon -match '^\s*"([^"]+\.exe)"(?:\s*,\s*-?\d+)?\s*$') { $executable = Resolve-EvidencePath $Matches[1] }
                    elseif ($icon -match '^\s*([^"].*\.exe)(?:\s*,\s*-?\d+)?\s*$') { $executable = Resolve-EvidencePath $Matches[1] }
                    # DisplayIcon identifies only an executable, never its guessed parent folder.
                    $apps.Add([ordered]@{ name = $displayName; installLocation = $installLocation; executable = $executable; estimatedSizeKB = $appKey.GetValue('EstimatedSize', 0); publisher = [string]$appKey.GetValue('Publisher', ''); version = [string]$appKey.GetValue('DisplayVersion', '') })
                } catch { } finally { if ($null -ne $appKey) { $appKey.Dispose() } }
            }
        } catch { $warnings.Add('An uninstall registry view could not be read.') }
        finally {
            if ($null -ne $uninstallKey) { $uninstallKey.Dispose() }
            if ($null -ne $baseKey) { $baseKey.Dispose() }
        }
    }
}

$uaBase = $null
$uaKey = $null
$unresolvedCount = 0
try {
    try { $shortcutShell = New-Object -ComObject WScript.Shell } catch { $warnings.Add('Shortcut target resolution unavailable.') }
    $uaBase = [Microsoft.Win32.RegistryKey]::OpenBaseKey([Microsoft.Win32.RegistryHive]::CurrentUser, [Microsoft.Win32.RegistryView]::Default)
    $uaKey = $uaBase.OpenSubKey('Software\Microsoft\Windows\CurrentVersion\Explorer\UserAssist', $false)
    if ($null -ne $uaKey) {
        foreach ($subkeyName in $uaKey.GetSubKeyNames()) {
            $countKey = $null
            try {
                $countKey = $uaKey.OpenSubKey($subkeyName + '\Count', $false)
                if ($null -eq $countKey) { continue }
                foreach ($encodedName in $countKey.GetValueNames()) {
                    $data = $countKey.GetValue($encodedName, $null, [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
                    if ($data -isnot [byte[]] -or $data.Length -lt 72) { continue }
                    $decoded = Convert-Rot13 $encodedName
                    $evidencePath = Resolve-EvidencePath $decoded
                    if (-not $evidencePath) { $unresolvedCount++; continue }
                    $shortcut = $false
                    if ([IO.Path]::GetExtension($evidencePath) -ieq '.lnk') {
                        # Do not resolve network shortcuts or invoke their target; never call Save().
                        if (-not $shortcutShell -or $evidencePath.StartsWith('\\') -or -not [IO.File]::Exists($evidencePath)) { $unresolvedCount++; continue }
                        $link = $null
                        try {
                            $link = $shortcutShell.CreateShortcut($evidencePath)
                            $evidencePath = Resolve-EvidencePath ([string]$link.TargetPath)
                            $shortcut = $true
                        } catch { $evidencePath = $null }
                        finally { if ($null -ne $link) { [void][Runtime.InteropServices.Marshal]::ReleaseComObject($link) } }
                        if (-not $evidencePath) { $unresolvedCount++; continue }
                    }
                    $userAssist.Add([ordered]@{ encodedName = $encodedName; path = $evidencePath; data = [Convert]::ToBase64String($data); shortcut = $shortcut })
                }
            } catch { $warnings.Add('Some current-user UserAssist records could not be read.') }
            finally { if ($null -ne $countKey) { $countKey.Dispose() } }
        }
    }
} catch { $warnings.Add('Current-user UserAssist is unavailable.') }
finally {
    if ($null -ne $uaKey) { $uaKey.Dispose() }
    if ($null -ne $uaBase) { $uaBase.Dispose() }
    if ($null -ne $shortcutShell) { [void][Runtime.InteropServices.Marshal]::ReleaseComObject($shortcutShell) }
}
if ($unresolvedCount -gt 0) { $warnings.Add("Skipped $unresolvedCount records without a resolvable local target.") }

$inaccessibleProcesses = 0
try {
    foreach ($runningProcess in Get-Process -ErrorAction Stop) {
        try {
            $processPath = $runningProcess.Path
            if ($processPath) { $processPaths.Add($processPath) }
            else { $inaccessibleProcesses++ }
        } catch { $inaccessibleProcesses++ }
        finally { $runningProcess.Dispose() }
    }
} catch { $warnings.Add('Running process paths are unavailable.') }
if ($inaccessibleProcesses -gt 0) { $warnings.Add("Executable paths unavailable for $inaccessibleProcesses protected or inaccessible processes.") }

$policy = 'Unknown; file access timestamps are not used as application usage evidence.'
$fileSystemKey = $null
try {
    $fileSystemKey = [Microsoft.Win32.Registry]::LocalMachine.OpenSubKey('SYSTEM\CurrentControlSet\Control\FileSystem', $false)
    $policyValue = $fileSystemKey.GetValue('NtfsDisableLastAccessUpdate', $null)
    if ($null -ne $policyValue) {
        $unsignedPolicy = [BitConverter]::ToUInt32([BitConverter]::GetBytes([int]$policyValue), 0)
        $policy = 'NtfsDisableLastAccessUpdate=0x' + $unsignedPolicy.ToString('X8') + '; not used as application usage evidence.'
    }
} catch { } finally { if ($null -ne $fileSystemKey) { $fileSystemKey.Dispose() } }

$output = [ordered]@{
    collectedAt = $collectedAt
    apps = $apps.ToArray()
    userAssist = $userAssist.ToArray()
    processes = $processPaths.ToArray()
    warnings = @($warnings.ToArray() | Select-Object -Unique)
    lastAccessPolicy = $policy
}
[Console]::Write(($output | ConvertTo-Json -Depth 6 -Compress))
