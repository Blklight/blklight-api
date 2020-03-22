'use strict'

/** @type {import('@adonisjs/lucid/src/Schema')} */
const Schema = use('Schema')

class ChannelSchema extends Schema {
  up () {
    this.create('channels', (table) => {
      table.increments()
      table.string('name', 100).notNullable()
      table.text('description')
      table.text('logo')
      table.timestamps()
    })
  }

  down () {
    this.drop('channels')
  }
}

module.exports = ChannelSchema
