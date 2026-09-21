import type { Project } from "./language.js";
export const example: Project = {
  name: "@local/contacts",
  currentFile: "contacts.forge",
  files: [
    {
      path: "contacts.forge",
      text: `// A small Forge model. Every visual edit updates this source.
export purpose ServiceProvision
export purpose CustomerSupport extends ServiceProvision
export purpose Marketing

export dataClass ContactEmail extends data.contact.email

export resource Contact
  @tenant
  @timestamps
  @versioned
  @purposeScoped
  @subject(person)
{
  id : id
  name : text length 1..120 @data(data.identity.name)
  email : email @data(ContactEmail)

  capability Directory {
    read { id name }
  }

  capability Support {
    includes Directory
    read { email }
    update { email }
  }

  for CustomerSupport { use Support }
}

export resource Note
  @tenant
  @timestamps
  @versioned
{
  id : id
  contact : Contact
  body : text length 1..2000 @data(data.communication.content)
}
`,
    },
  ],
};
