/** Match DynamoStorage's exact single-table key contract, not Dynamo Local defaults. */
export function validDynamoTable(table) {
  return table?.TableStatus === 'ACTIVE' && typeof table.TableArn === 'string'
    && table.KeySchema?.length === 2
    && table.KeySchema.some(key => key.AttributeName === 'PK' && key.KeyType === 'HASH')
    && table.KeySchema.some(key => key.AttributeName === 'SK' && key.KeyType === 'RANGE')
    && ['PK', 'SK'].every(name => table.AttributeDefinitions?.some(attribute => attribute.AttributeName === name && attribute.AttributeType === 'S'));
}
