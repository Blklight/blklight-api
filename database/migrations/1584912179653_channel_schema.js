'use strict'

/** @type {import('@adonisjs/lucid/src/Schema')} */
const Schema = use('Schema')

class ChannelSchema extends Schema {
  up () {
    this.create('channels', (table) => {
      table.increments()
      table.string('name', 200).notNullable().unique()
      table.text('description').nullable()
      table.text('channel_logo').notNullable().defaultTo('https://i.imgur.com/txJ6DPX.jpg')
      table.text('channel_artwork').nullable()
      table.timestamps()
    })
  }

  down () {
    this.drop('channels')
  }
}

module.exports = ChannelSchema
