import AppKit
import Foundation
import LocalAuthentication
import Security

#if canImport(Darwin)
import Darwin
#endif

private let protocolVersion = 1
private let allowedService = "codex-polymarket-guarded"
private let allowedAccounts: Set<String> = [
    "social-private-key.v1",
    "l2-credentials.v1",
    "session-authorization.v1",
]
private let maximumFrameBytes = 128 * 1024
private let maximumSecretBytes = 64 * 1024
private let secp256k1CurveOrder = Data([
    0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff,
    0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xfe,
    0xba, 0xae, 0xdc, 0xe6, 0xaf, 0x48, 0xa0, 0x3b,
    0xbf, 0xd2, 0x5e, 0x8c, 0xd0, 0x36, 0x41, 0x41,
])

private enum HelperCode: String {
    case ok = "OK"
    case badRequest = "BAD_REQUEST"
    case unsupported = "UNSUPPORTED"
    case invalidSecret = "INVALID_SECRET"
    case duplicate = "DUPLICATE"
    case notFound = "NOT_FOUND"
    case authenticationCancelled = "AUTHENTICATION_CANCELLED"
    case authenticationFailed = "AUTHENTICATION_FAILED"
    case keychainUnavailable = "KEYCHAIN_UNAVAILABLE"
    case internalError = "INTERNAL_ERROR"
}

private enum HelperOperation: String {
    case status
    case importSocialKey = "import-social-key"
    case authorizeSession = "authorize-session"
    case put
    case read
}

private struct Request {
    let operation: HelperOperation
    let service: String
    let account: String
    let reason: String?
    let payload: Data
}

private struct ResponseHeader: Encodable {
    let version: Int
    let ok: Bool
    let code: String
    let payloadLength: Int
    let exists: Bool?
}

private struct FixedHelperError: Error {
    let code: HelperCode
}

private enum KeychainHelper {
    static func run() {
        disableCoreDumps()

        do {
            let request = try readRequest()
            let response = try perform(request)
            try writeResponse(
                code: .ok,
                payload: response.payload,
                exists: response.exists
            )
        } catch let error as FixedHelperError {
            try? writeResponse(code: error.code, payload: Data(), exists: nil)
            Foundation.exit(EXIT_FAILURE)
        } catch {
            try? writeResponse(code: .internalError, payload: Data(), exists: nil)
            Foundation.exit(EXIT_FAILURE)
        }
    }
}

private func disableCoreDumps() {
    #if canImport(Darwin)
    var limit = rlimit(rlim_cur: 0, rlim_max: 0)
    _ = setrlimit(RLIMIT_CORE, &limit)
    #endif
}

private func readRequest() throws -> Request {
    guard CommandLine.arguments.count == 1 else {
        throw FixedHelperError(code: .badRequest)
    }

    guard
        let frame = try FileHandle.standardInput.readToEnd(),
        frame.count >= 4,
        frame.count <= maximumFrameBytes
    else {
        throw FixedHelperError(code: .badRequest)
    }

    let headerLength = Int(readUInt32BigEndian(frame, at: 0))
    guard
        headerLength > 0,
        headerLength <= maximumFrameBytes - 4,
        frame.count >= 4 + headerLength
    else {
        throw FixedHelperError(code: .badRequest)
    }

    let headerData = frame.subdata(in: 4..<(4 + headerLength))
    guard
        let json = try JSONSerialization.jsonObject(with: headerData) as? [String: Any],
        json["version"] as? Int == protocolVersion,
        let operationName = json["operation"] as? String,
        let operation = HelperOperation(rawValue: operationName),
        let service = json["service"] as? String,
        let account = json["account"] as? String,
        let payloadLength = json["payloadLength"] as? Int,
        payloadLength >= 0,
        payloadLength <= maximumSecretBytes,
        frame.count == 4 + headerLength + payloadLength
    else {
        throw FixedHelperError(code: .badRequest)
    }

    guard service == allowedService, allowedAccounts.contains(account) else {
        throw FixedHelperError(code: .unsupported)
    }

    let reason: String?
    if let rawReason = json["reason"] {
        guard let candidate = rawReason as? String, isSafeReason(candidate) else {
            throw FixedHelperError(code: .badRequest)
        }
        reason = candidate
    } else {
        reason = nil
    }

    let payloadStart = 4 + headerLength
    let payload = frame.subdata(in: payloadStart..<frame.count)

    switch operation {
    case .status, .importSocialKey, .read:
        guard payload.isEmpty else {
            throw FixedHelperError(code: .badRequest)
        }
    case .authorizeSession:
        guard account == "session-authorization.v1", !payload.isEmpty else {
            throw FixedHelperError(code: .badRequest)
        }
    case .put:
        guard !payload.isEmpty else {
            throw FixedHelperError(code: .invalidSecret)
        }
    }

    return Request(
        operation: operation,
        service: service,
        account: account,
        reason: reason,
        payload: payload
    )
}

private func perform(_ request: Request) throws -> (payload: Data, exists: Bool?) {
    switch request.operation {
    case .status:
        return (Data(), try keychainItemExists(service: request.service, account: request.account))

    case .importSocialKey:
        guard request.account == "social-private-key.v1" else {
            throw FixedHelperError(code: .unsupported)
        }
        deleteProtectedItem(service: request.service, account: request.account)

        var secret = try promptForSocialPrivateKey()
        defer {
            secret.resetBytes(in: 0..<secret.count)
        }
        try addProtectedItem(
            secret,
            service: request.service,
            account: request.account,
            label: "Polymarket social signing key"
        )
        return (Data(), true)

    case .authorizeSession:
        return (try authorizeTradingSession(request.payload), true)

    case .put:
        guard request.account == "l2-credentials.v1" else {
            throw FixedHelperError(code: .unsupported)
        }
        deleteProtectedItem(service: request.service, account: request.account)
        try addProtectedItem(
            request.payload,
            service: request.service,
            account: request.account,
            label: request.account == "l2-credentials.v1"
                ? "Polymarket CLOB L2 credentials"
                : "Polymarket protected secret"
        )
        return (Data(), true)

    case .read:
        guard let reason = request.reason else {
            throw FixedHelperError(code: .badRequest)
        }
        let secret = try readProtectedItem(
            service: request.service,
            account: request.account,
            reason: reason
        )
        return (secret, true)
    }
}

private func authorizeTradingSession(_ payload: Data) throws -> Data {
    guard
        let json = try JSONSerialization.jsonObject(with: payload) as? [String: Any],
        let pendingSessionId = json["pendingSessionId"] as? String,
        isSafeIdentifier(pendingSessionId),
        let executionMode = json["executionMode"] as? String,
        executionMode == "paper" || executionMode == "live",
        let maximumAuthorizableMicros = json["maximumAuthorizableMicros"] as? String,
        let maximumMicros = parseMicros(maximumAuthorizableMicros),
        maximumMicros > 0,
        let expiresAtMs = json["expiresAtMs"] as? Int64
    else {
        throw FixedHelperError(code: .badRequest)
    }

    let nowMs = Int64(Date().timeIntervalSince1970 * 1000)
    guard nowMs <= expiresAtMs else {
        throw FixedHelperError(code: .authenticationCancelled)
    }

    // The helper is launched as a short-lived command-line process. Make its
    // native authorization window visible and frontmost before entering the
    // modal loop; otherwise launchd/Terminal can leave the prompt behind
    // another window until the IPC caller times out.
    let application = NSApplication.shared
    application.setActivationPolicy(.accessory)
    setupEditMenuIfNeeded()
    application.activate(ignoringOtherApps: true)

    let amountField = NSSecureTextField(frame: NSRect(x: 0, y: 0, width: 430, height: 24))
    amountField.placeholderString = "Amount in pUSD (maximum shown below)"
    amountField.isAutomaticTextCompletionEnabled = false

    let alert = NSAlert()
    alert.alertStyle = .informational
    alert.messageText = "Authorize \(executionMode) trading session"
    alert.informativeText =
        "Enter the maximum pUSD budget for this session. The native authorization is valid once and expires with the prepared session.\nMaximum: \(formatMicros(maximumMicros)) pUSD"
    alert.accessoryView = amountField
    alert.addButton(withTitle: "Authorize session")
    alert.addButton(withTitle: "Cancel")
    alert.window.initialFirstResponder = amountField

    let result = alert.runModal()
    guard result == .alertFirstButtonReturn else {
        amountField.stringValue = ""
        throw FixedHelperError(code: .authenticationCancelled)
    }
    let enteredAmount = amountField.stringValue
    amountField.stringValue = ""
    guard let amountMicros = parseMicros(enteredAmount), amountMicros > 0 else {
        throw FixedHelperError(code: .badRequest)
    }
    guard amountMicros <= maximumMicros else {
        throw FixedHelperError(code: .badRequest)
    }

    try requireUserPresence()

    var nonce = Data(repeating: 0, count: 32)
    defer { nonce.resetBytes(in: 0..<nonce.count) }
    let randomStatus = nonce.withUnsafeMutableBytes { buffer in
        SecRandomCopyBytes(kSecRandomDefault, buffer.count, buffer.baseAddress!)
    }
    guard randomStatus == errSecSuccess else {
        throw FixedHelperError(code: .internalError)
    }

    let response: [String: Any] = [
        "pendingSessionId": pendingSessionId,
        "amountMicros": String(amountMicros),
        "confirmedAtMs": Int64(Date().timeIntervalSince1970 * 1000),
        "attestationNonce": hex(nonce),
        "source": "macos-native-user-presence",
    ]
    return try JSONSerialization.data(withJSONObject: response, options: [])
}

private func requireUserPresence() throws {
    let context = LAContext()
    context.localizedReason = "Authorize one Polymarket trading session"

    var result: (Bool, Error?)?
    context.evaluatePolicy(.deviceOwnerAuthentication, localizedReason: context.localizedReason) {
        success, error in
        result = (success, error)
    }
    while result == nil {
        RunLoop.current.run(mode: .default, before: Date(timeIntervalSinceNow: 0.05))
    }
    guard result?.0 == true else {
        if let error = result?.1 as NSError?, error.code == LAError.userCancel.rawValue {
            throw FixedHelperError(code: .authenticationCancelled)
        }
        throw FixedHelperError(code: .authenticationFailed)
    }
}

private func parseMicros(_ value: String) -> UInt64? {
    let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
    let parts = trimmed.split(separator: ".", omittingEmptySubsequences: false)
    guard parts.count <= 2, !parts.isEmpty else { return nil }
    let wholePart = String(parts[0])
    guard !wholePart.isEmpty, wholePart.allSatisfy({ $0.isNumber }) else { return nil }
    let fractionPart = parts.count == 2 ? String(parts[1]) : ""
    guard fractionPart.count <= 6, fractionPart.allSatisfy({ $0.isNumber }) else { return nil }
    guard let whole = UInt64(wholePart) else { return nil }
    let fraction = UInt64(fractionPart.padding(toLength: 6, withPad: "0", startingAt: 0)) ?? 0
    let scale: UInt64 = 1_000_000
    guard whole <= (UInt64.max - fraction) / scale else { return nil }
    return whole * scale + fraction
}

private func formatMicros(_ micros: UInt64) -> String {
    let whole = micros / 1_000_000
    let fraction = micros % 1_000_000
    if fraction == 0 { return String(whole) }
    return "\(whole).\(String(format: "%06llu", fraction).replacingOccurrences(of: "0+$", with: "", options: .regularExpression))"
}

private func hex(_ data: Data) -> String {
    data.map { String(format: "%02x", $0) }.joined()
}

private func isSafeIdentifier(_ value: String) -> Bool {
    !value.isEmpty && value.utf8.count <= 160 && value.unicodeScalars.allSatisfy { scalar in
        scalar.value >= 0x20 && scalar.value != 0x7f
    }
}

private func promptForSocialPrivateKey() throws -> Data {
    let application = NSApplication.shared
    application.setActivationPolicy(.accessory)
    setupEditMenuIfNeeded()
    application.activate(ignoringOtherApps: true)

    let field = NSSecureTextField(frame: NSRect(x: 0, y: 0, width: 430, height: 24))
    field.placeholderString = "64 hexadecimal characters"
    field.isAutomaticTextCompletionEnabled = false

    let alert = NSAlert()
    alert.alertStyle = .informational
    alert.messageText = "Import Polymarket signing key"
    alert.informativeText =
        "The key is stored directly in this Mac's protected Keychain. It is never printed."
    alert.accessoryView = field
    alert.addButton(withTitle: "Store securely")
    alert.addButton(withTitle: "Cancel")
    alert.window.initialFirstResponder = field

    let result = alert.runModal()
    guard result == .alertFirstButtonReturn else {
        field.stringValue = ""
        throw FixedHelperError(code: .authenticationCancelled)
    }

    let entered = field.stringValue
    field.stringValue = ""
    guard let decoded = decodePrivateKey(entered) else {
        throw FixedHelperError(code: .invalidSecret)
    }
    return decoded
}

private func setupEditMenuIfNeeded() {
    guard NSApp.mainMenu == nil else { return }
    let mainMenu = NSMenu()
    let editMenuItem = NSMenuItem()
    let editMenu = NSMenu(title: "Edit")
    editMenu.addItem(withTitle: "Cut", action: #selector(NSText.cut(_:)), keyEquivalent: "x")
    editMenu.addItem(withTitle: "Copy", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
    editMenu.addItem(withTitle: "Paste", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
    editMenu.addItem(withTitle: "Select All", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")
    editMenuItem.submenu = editMenu
    mainMenu.addItem(editMenuItem)
    NSApp.mainMenu = mainMenu
}

private func decodePrivateKey(_ input: String) -> Data? {
    var value = input.trimmingCharacters(in: .whitespacesAndNewlines)
    if (value.hasPrefix("\"") && value.hasSuffix("\"")) || (value.hasPrefix("'") && value.hasSuffix("'")) {
        value = String(value.dropFirst().dropLast()).trimmingCharacters(in: .whitespacesAndNewlines)
    }
    if value.hasPrefix("0x") || value.hasPrefix("0X") {
        value.removeFirst(2)
    }
    value = value.trimmingCharacters(in: .whitespacesAndNewlines)
    guard value.utf8.count == 64 else {
        return nil
    }

    var result = Data(capacity: 32)
    var index = value.startIndex
    for _ in 0..<32 {
        let next = value.index(index, offsetBy: 2)
        let pair = value[index..<next]
        guard let byte = UInt8(pair, radix: 16) else {
            result.resetBytes(in: 0..<result.count)
            return nil
        }
        result.append(byte)
        index = next
    }

    guard
        result.contains(where: { $0 != 0 }),
        result.lexicographicallyPrecedes(secp256k1CurveOrder)
    else {
        result.resetBytes(in: 0..<result.count)
        return nil
    }
    return result
}

private func makeAccessControl() throws -> SecAccessControl {
    var accessError: Unmanaged<CFError>?
    guard let access = SecAccessControlCreateWithFlags(
        nil,
        kSecAttrAccessibleWhenPasscodeSetThisDeviceOnly,
        [.userPresence],
        &accessError
    ) else {
        throw FixedHelperError(code: .keychainUnavailable)
    }
    return access
}

private func baseQuery(service: String, account: String) -> [String: Any] {
    [
        kSecClass as String: kSecClassGenericPassword,
        kSecAttrService as String: service,
        kSecAttrAccount as String: account,
    ]
}

private func deleteProtectedItem(service: String, account: String) {
    let query = baseQuery(service: service, account: account)
    _ = SecItemDelete(query as CFDictionary)
}

private func addProtectedItem(
    _ secret: Data,
    service: String,
    account: String,
    label: String
) throws {
    guard !secret.isEmpty, secret.count <= maximumSecretBytes else {
        throw FixedHelperError(code: .invalidSecret)
    }

    var query = baseQuery(service: service, account: account)
    query[kSecAttrLabel as String] = label
    query[kSecAttrSynchronizable as String] = false
    query[kSecAttrAccessible as String] = kSecAttrAccessibleWhenUnlockedThisDeviceOnly
    query[kSecValueData as String] = secret

    var status = SecItemAdd(query as CFDictionary, nil)
    if status == errSecDuplicateItem {
        let deleteQuery = baseQuery(service: service, account: account)
        _ = SecItemDelete(deleteQuery as CFDictionary)
        status = SecItemAdd(query as CFDictionary, nil)
    }
    switch status {
    case errSecSuccess:
        return
    case errSecDuplicateItem:
        throw FixedHelperError(code: .duplicate)
    case errSecAuthFailed, errSecInteractionNotAllowed, errSecNotAvailable:
        throw FixedHelperError(code: .keychainUnavailable)
    default:
        fputs("[keychain-helper] SecItemAdd OSStatus error: \(status)\n", stderr)
        throw FixedHelperError(code: .internalError)
    }
}

private func keychainItemExists(service: String, account: String) throws -> Bool {
    let context = LAContext()
    context.interactionNotAllowed = true

    var query = baseQuery(service: service, account: account)
    query[kSecMatchLimit as String] = kSecMatchLimitOne
    query[kSecReturnAttributes as String] = true
    query[kSecUseAuthenticationContext as String] = context

    var attributes: CFTypeRef?
    let status = SecItemCopyMatching(query as CFDictionary, &attributes)
    attributes = nil
    switch status {
    case errSecSuccess, errSecInteractionNotAllowed:
        return true
    case errSecItemNotFound:
        return false
    case errSecNotAvailable:
        throw FixedHelperError(code: .keychainUnavailable)
    default:
        // OSStatus is a non-secret diagnostic; keep it on stderr so the
        // JSON-RPC/pipe response remains protocol-clean.
        fputs("[keychain-helper] SecItemCopyMatching status: \(status)\n", stderr)
        throw FixedHelperError(code: .internalError)
    }
}

private func readProtectedItem(
    service: String,
    account: String,
    reason: String
) throws -> Data {
    // If the item still requires one-time approval, surface the macOS
    // authorization prompt instead of leaving it behind a terminal/launchd
    // window until the IPC timeout. Normal unattended reads remain promptless
    // once the helper has been granted access in Keychain Access.
    let application = NSApplication.shared
    application.setActivationPolicy(.accessory)
    application.activate(ignoringOtherApps: true)

    let context = LAContext()
    context.localizedReason = reason
    context.touchIDAuthenticationAllowableReuseDuration = 0

    var query = baseQuery(service: service, account: account)
    query[kSecMatchLimit as String] = kSecMatchLimitOne
    query[kSecReturnData as String] = true
    query[kSecUseAuthenticationContext as String] = context

    var item: CFTypeRef?
    let status = SecItemCopyMatching(query as CFDictionary, &item)
    switch status {
    case errSecSuccess:
        guard let data = item as? Data, !data.isEmpty, data.count <= maximumSecretBytes else {
            throw FixedHelperError(code: .invalidSecret)
        }
        return data
    case errSecItemNotFound:
        throw FixedHelperError(code: .notFound)
    case errSecUserCanceled:
        throw FixedHelperError(code: .authenticationCancelled)
    case errSecAuthFailed:
        throw FixedHelperError(code: .authenticationFailed)
    case errSecInteractionNotAllowed, errSecNotAvailable:
        throw FixedHelperError(code: .keychainUnavailable)
    default:
        throw FixedHelperError(code: .internalError)
    }
}

private func isSafeReason(_ value: String) -> Bool {
    guard !value.isEmpty, value.utf8.count <= 180 else {
        return false
    }
    return value.unicodeScalars.allSatisfy { scalar in
        scalar.value >= 0x20 && scalar.value != 0x7f
    }
}

private func readUInt32BigEndian(_ data: Data, at offset: Int) -> UInt32 {
    let bytes = [UInt8](data[offset..<(offset + 4)])
    return (UInt32(bytes[0]) << 24)
        | (UInt32(bytes[1]) << 16)
        | (UInt32(bytes[2]) << 8)
        | UInt32(bytes[3])
}

private func writeResponse(code: HelperCode, payload: Data, exists: Bool?) throws {
    let header = ResponseHeader(
        version: protocolVersion,
        ok: code == .ok,
        code: code.rawValue,
        payloadLength: payload.count,
        exists: exists
    )
    let headerData = try JSONEncoder().encode(header)
    guard headerData.count <= maximumFrameBytes - 4 - payload.count else {
        throw FixedHelperError(code: .internalError)
    }

    var frame = Data()
    var headerLength = UInt32(headerData.count).bigEndian
    withUnsafeBytes(of: &headerLength) { frame.append(contentsOf: $0) }
    frame.append(headerData)
    frame.append(payload)
    try FileHandle.standardOutput.write(contentsOf: frame)
}

KeychainHelper.run()
