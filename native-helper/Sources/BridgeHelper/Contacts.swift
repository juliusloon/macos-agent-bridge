import Foundation
import Contacts
@MainActor final class ContactsAdapter {
    let store = CNContactStore()
    let keys: [CNKeyDescriptor] = [CNContactIdentifierKey as CNKeyDescriptor, CNContactGivenNameKey as CNKeyDescriptor, CNContactFamilyNameKey as CNKeyDescriptor, CNContactEmailAddressesKey as CNKeyDescriptor, CNContactPhoneNumbersKey as CNKeyDescriptor]
    func value(_ c: CNContact) -> [String: Any] { ["id": c.identifier, "givenName": c.givenName, "familyName": c.familyName, "emails": c.emailAddresses.map { $0.value as String }, "phones": c.phoneNumbers.map { $0.value.stringValue }] }
    func handle(_ name: String, _ args: [String: Any]) throws -> Any {
        let status = CNContactStore.authorizationStatus(for: .contacts)
        guard status == .authorized || status.rawValue == 4 else { throw fail("PERMISSION_REQUIRED", "Request Contacts permission in Raycast first.") }
        if name == "contacts_search" { let query = try text(args, "query"); let request = CNContactFetchRequest(keysToFetch: keys); if !query.isEmpty { request.predicate = CNContact.predicateForContacts(matchingName: query) }; var all: [[String: Any]] = []; try store.enumerateContacts(with: request) { contact, stop in all.append(self.value(contact)); if all.count >= limit(args) { stop.pointee = true } }; return ["contacts": all, "limitedAccess": status.rawValue == 4] }
        if name == "contacts_get" { return value(try store.unifiedContact(withIdentifier: text(args, "id"), keysToFetch: keys)) }
        let contact: CNMutableContact
        if name == "contacts_create" { contact = CNMutableContact() }
        else { contact = try store.unifiedContact(withIdentifier: text(args, "id"), keysToFetch: keys).mutableCopy() as! CNMutableContact }
        if let v = args["givenName"] as? String { contact.givenName = v }; if let v = args["familyName"] as? String { contact.familyName = v }
        if let v = args["email"] as? String { contact.emailAddresses = [CNLabeledValue(label: CNLabelWork, value: v as NSString)] }
        if let v = args["phone"] as? String { contact.phoneNumbers = [CNLabeledValue(label: CNLabelPhoneNumberMain, value: CNPhoneNumber(stringValue: v))] }
        let request = CNSaveRequest(); if name == "contacts_create" { request.add(contact, toContainerWithIdentifier: nil) } else { request.update(contact) }; try store.execute(request); return value(contact)
    }
}
