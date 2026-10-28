#define NOMINMAX
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <aclapi.h>
#include <sddl.h>

#include <array>
#include <filesystem>
#include <iostream>
#include <string>

#include "install_access_win.h"
#include "json.h"

namespace lp {
namespace {
namespace fs = std::filesystem;

struct LocalMemory {
  void* value = nullptr;
  ~LocalMemory() { if (value) LocalFree(value); }
};

DWORD readAcl(const fs::path& path, PACL& acl, LocalMemory& descriptor) {
  return GetNamedSecurityInfoW(path.c_str(), SE_FILE_OBJECT, DACL_SECURITY_INFORMATION,
    nullptr, nullptr, &acl, nullptr, reinterpret_cast<PSECURITY_DESCRIPTOR*>(&descriptor.value));
}

bool specificPackageSid(PSID sid) {
  if (!IsValidSid(sid) || *GetSidSubAuthorityCount(sid) < 3) return false;
  const SID_IDENTIFIER_AUTHORITY authority = SECURITY_APP_PACKAGE_AUTHORITY;
  return memcmp(GetSidIdentifierAuthority(sid), &authority, sizeof(authority)) == 0 &&
    *GetSidSubAuthority(sid, 0) == SECURITY_APP_PACKAGE_BASE_RID;
}

struct AccessState { bool specificPackage = false; bool packageRead = false; bool packageReadDenied = false; };
AccessState inspect(PACL acl) {
  AccessState out;
  if (!acl) return out;
  for (DWORD n = 0; n < acl->AceCount; ++n) {
    void* entry = nullptr;
    if (!GetAce(acl, n, &entry)) continue;
    const auto header = static_cast<ACE_HEADER*>(entry);
    if (header->AceFlags & INHERIT_ONLY_ACE) continue;
    if (header->AceType != ACCESS_ALLOWED_ACE_TYPE && header->AceType != ACCESS_DENIED_ACE_TYPE) continue;
    const auto ace = static_cast<ACCESS_ALLOWED_ACE*>(entry);
    PSID sid = &ace->SidStart;
    if (specificPackageSid(sid)) out.specificPackage = true;
    if (header->AceType == ACCESS_DENIED_ACE_TYPE && IsWellKnownSid(sid, WinBuiltinAnyPackageSid) &&
        (ace->Mask & (FILE_READ_DATA | GENERIC_READ | GENERIC_ALL))) out.packageReadDenied = true;
    if (header->AceType == ACCESS_ALLOWED_ACE_TYPE && IsWellKnownSid(sid, WinBuiltinAnyPackageSid) &&
        ((ace->Mask & FILE_GENERIC_READ) == FILE_GENERIC_READ || (ace->Mask & GENERIC_READ))) out.packageRead = true;
  }
  return out;
}

DWORD checkTree(const fs::path& root) {
  // Never let an inheritable grant reach a junction, symbolic link or another installation.
  for (fs::path parent = root; !parent.empty();) {
    const DWORD attrs = GetFileAttributesW(parent.c_str());
    if (attrs == INVALID_FILE_ATTRIBUTES) return GetLastError();
    if (attrs & FILE_ATTRIBUTE_REPARSE_POINT) return ERROR_REPARSE_TAG_INVALID;
    const auto next = parent.parent_path();
    if (next == parent) break;
    parent = next;
  }
  std::error_code error;
  fs::recursive_directory_iterator it(root, error), end;
  while (!error && it != end) {
    const DWORD attrs = GetFileAttributesW(it->path().c_str());
    if (attrs == INVALID_FILE_ATTRIBUTES) return GetLastError();
    if (attrs & FILE_ATTRIBUTE_REPARSE_POINT) return ERROR_REPARSE_TAG_INVALID;
    it.increment(error);
  }
  return error ? static_cast<DWORD>(error.value()) : ERROR_SUCCESS;
}

std::string priorDacl(PSECURITY_DESCRIPTOR descriptor) {
  LocalMemory text;
  if (!ConvertSecurityDescriptorToStringSecurityDescriptorA(descriptor, SDDL_REVISION_1,
      DACL_SECURITY_INFORMATION, reinterpret_cast<LPSTR*>(&text.value), nullptr)) return {};
  return static_cast<const char*>(text.value);
}

void reply(const char* status, DWORD code, const std::string& before = {}) {
  std::cout << "{\"status\":\"" << status << "\",\"code\":" << code;
  if (!before.empty()) std::cout << ",\"beforeDacl\":\"" << jsonEscape(before) << '"';
  std::cout << "}\n";
}
}  // namespace

int ensureInstallAccess() {
  try {
    std::array<wchar_t, 32768> module{};
    const DWORD length = GetModuleFileNameW(nullptr, module.data(), static_cast<DWORD>(module.size()));
    if (!length || length == module.size()) { reply("failed", ERROR_BAD_PATHNAME); return 0; }
    const fs::path helper(module.data());
    const fs::path root = helper.parent_path().parent_path();
    // There is no user-supplied path: the helper must be in <install>/resources.
    if (helper.parent_path().filename() != L"resources" || root == root.root_path() ||
        !fs::is_regular_file(root / L"lolPing.exe") || !fs::is_regular_file(root / L"icudtl.dat") ||
        !fs::is_regular_file(root / L"resources" / L"app.asar")) {
      reply("failed", ERROR_BAD_PATHNAME); return 0;
    }
    PACL fileAcl = nullptr;
    LocalMemory fileDescriptor;
    DWORD code = readAcl(root / L"icudtl.dat", fileAcl, fileDescriptor);
    if (code) { reply("failed", code); return 0; }
    const auto access = inspect(fileAcl);
    if (access.packageReadDenied) { reply("failed", ERROR_ACCESS_DENIED); return 0; }
    if (!access.specificPackage || access.packageRead) { reply("unchanged", 0); return 0; }
    code = checkTree(root);
    if (code) { reply("failed", code); return 0; }
    PACL rootAcl = nullptr;
    LocalMemory rootDescriptor;
    code = readAcl(root, rootAcl, rootDescriptor);
    if (code) { reply("failed", code); return 0; }
    const auto before = priorDacl(rootDescriptor.value);
    std::array<DWORD, (SECURITY_MAX_SID_SIZE + sizeof(DWORD) - 1) / sizeof(DWORD)> sid{};
    DWORD sidBytes = static_cast<DWORD>(sid.size() * sizeof(DWORD));
    if (!CreateWellKnownSid(WinBuiltinAnyPackageSid, nullptr, sid.data(), &sidBytes)) {
      reply("failed", GetLastError(), before); return 0;
    }
    EXPLICIT_ACCESSW grant{};
    grant.grfAccessPermissions = FILE_GENERIC_READ | FILE_GENERIC_EXECUTE;
    grant.grfAccessMode = GRANT_ACCESS;
    grant.grfInheritance = SUB_CONTAINERS_AND_OBJECTS_INHERIT;
    grant.Trustee.TrusteeForm = TRUSTEE_IS_SID;
    grant.Trustee.TrusteeType = TRUSTEE_IS_WELL_KNOWN_GROUP;
    grant.Trustee.ptstrName = reinterpret_cast<LPWSTR>(sid.data());
    LocalMemory merged;
    code = SetEntriesInAclW(1, &grant, rootAcl, reinterpret_cast<PACL*>(&merged.value));
    if (!code) code = SetNamedSecurityInfoW(const_cast<LPWSTR>(root.c_str()), SE_FILE_OBJECT,
      DACL_SECURITY_INFORMATION, nullptr, nullptr, static_cast<PACL>(merged.value), nullptr);
    if (code) { reply("failed", code, before); return 0; }
    PACL verified = nullptr;
    LocalMemory verifiedDescriptor;
    code = readAcl(root / L"icudtl.dat", verified, verifiedDescriptor);
    if (!code && !inspect(verified).packageRead) code = ERROR_ACCESS_DENIED;
    reply(code ? "failed" : "repaired", code, before);
  } catch (const fs::filesystem_error& error) { reply("failed", static_cast<DWORD>(error.code().value())); }
  catch (...) { reply("failed", ERROR_GEN_FAILURE); }
  return 0;
}
}  // namespace lp
