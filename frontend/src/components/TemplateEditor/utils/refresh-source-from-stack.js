/* Copyright Contributors to the Open Cluster Management project */
'use strict'

import { diff } from 'deep-diff'
import jsYaml from 'js-yaml'
import {
  discoverControls,
  setEditingMode,
  reverseTemplate,
  getImmutables,
  getImmutableRows,
  setImmutableValues,
  parseYAML,
} from './source-utils'
import { generateSourceFromTemplate } from './refresh-source-from-templates'
import { mapResources } from '../../SyncEditor/reconcile'
import YamlParser from './YamlParser'
import cloneDeep from 'lodash/cloneDeep'
import merge from 'lodash/merge'
import uniqWith from 'lodash/uniqWith'
import set from 'lodash/set'
import unset from 'lodash/unset'
import get from 'lodash/get'
import omitBy from 'lodash/omitBy'
import isEmpty from 'lodash/isEmpty'
import isEqual from 'lodash/isEqual'
import pick from 'lodash/pick'
import keyBy from 'lodash/keyBy'

export const generateSourceFromStack = (template, editStack, controlData, otherYAMLTabs) => {
  if (!editStack.initialized) {
    intializeControls(editStack, controlData)
  }
  return generateSource(editStack, controlData, template, otherYAMLTabs)
}

// update edit stack after the user types something into the editor
// and then uses the form it doesn't wipe out what they just typed
export const updateEditStack = (editStack = {}, templateResources, parsedResources) => {
  const { initialized } = editStack
  if (!initialized) {
    editStack.deletedLinks = []
    editStack.initialized = true
  }

  // last template generation becomes the base template
  editStack.baseTemplateResources = templateResources

  // last content of editor becomes the custom resource
  editStack.customResources = parsedResources

  return editStack
}

const intializeControls = (editStack, controlData) => {
  const { customResources, editor, i18n } = editStack
  const { templateObject } = generateSourceFromResources(customResources)

  // determine the controls for this resource
  discoverControls(controlData, templateObject, editor, i18n)

  // refresh the values from the template for these controls
  reverseTemplate(controlData, templateObject)

  // put controls into editing mode (ex: disable name input)
  setEditingMode(controlData)

  // keep track of template changes
  editStack.baseTemplateResources = null
  editStack.deletedLinks = []
  editStack.initialized = true
}

const generateSource = (editStack, controlData, template, otherYAMLTabs) => {
  // set immutable values
  const immutables = getImmutables(controlData)
  setImmutableValues(immutables, editStack.customResources)

  // get the next iteration of template changes
  const { templateResources, templateObject } = generateSourceFromTemplate(template, controlData, otherYAMLTabs)

  // merge any custom changes in other yaml tabs into that tab
  mergeOtherYAMLTabs(otherYAMLTabs, templateResources)

  // save any secrets
  const secretsMap =
    templateObject.Secret &&
    keyBy(
      templateObject.Secret.filter(({ $raw: { metadata } }) => metadata),
      ({ $raw }) => {
        const {
          metadata: { name, namespace },
        } = $raw
        return `${namespace}/${name}`
      }
    )

  // first time thru, we just have the base template to compare against
  let currentTemplateResources
  let { baseTemplateResources } = editStack
  if (!baseTemplateResources) {
    editStack.baseTemplateResources = templateResources
    baseTemplateResources = templateResources
  } else {
    // next time we merge base and current templates into custom
    currentTemplateResources = templateResources
  }

  // merge generated templates with user edits
  let resources = mergeSource(editStack, baseTemplateResources, currentTemplateResources)

  // make sure there's no duplicates
  resources = uniqWith(resources, isEqual)

  // then generate the source from those resources
  const { templateYAML, templateObject: mergedObjects } = generateSourceFromResources(resources)

  // restore any secrets
  if (secretsMap && mergedObjects.Secret) {
    mergedObjects.Secret.forEach((resource) => {
      resource = resource.$raw
      if (resource.metadata) {
        const {
          metadata: { name, namespace },
        } = resource
        const secret = secretsMap[`${namespace}/${name}`]
        if (secret) {
          merge(resource, secret.$raw)
        }
      }
    })
  }

  const immutableRows = getImmutableRows(immutables, mergedObjects)

  return {
    templateYAML,
    templateObject: mergedObjects,
    templateResources,
    immutableRows,
  }
}

const mergeSource = (editStack, baseTemplateResources, currentTemplateResources) => {
  // the yaml files are generated by plugging input values into a handlebars template
  // if the user then edits that yaml everything is fine
  // but the next time a yaml file is generated we need to merge the user edit into what was automatically generated
  // so we get the differences between the two automatically generated templates -- before and after the user edits --
  // and merge just those differences into the user changed template

  const filter = (cloned, removed, addLinks) => {
    cloned.forEach((res1) => {
      if (removed.has(res1)) {
        const idx = editStack.customResources.findIndex((res2) => {
          return isEqual(res1, res2)
        })
        if (idx !== -1) {
          editStack.customResources.splice(idx, 1)
        }
      }
    })
    return (cloned = cloned.filter((res) => {
      if (removed.has(res)) {
        if (addLinks) {
          const deleteLink = merge(
            pick(res, ['apiVersion', 'kind']),
            pick(get(res, 'metadata', {}), ['selfLink', 'name', 'namespace'])
          )
          editStack.deletedLinks.push(deleteLink)
        }
        return false
      }
      return true
    }))
  }

  // first find the matching resource between the custom resources and the last generated template
  let customResources = cloneDeep(editStack.customResources)
  const { weakMap: weakBase, removedSet: removedBase } = mapResources(customResources, baseTemplateResources)
  // weakBase holds the matching resources
  // filter any custom resources that don't exist in the previous generated template
  if (removedBase.size) {
    // the base generated yaml file doesn't have it, just remove from custom
    customResources = filter(customResources, removedBase)
  }

  const clonedCurrentTemplateResources = currentTemplateResources && cloneDeep(currentTemplateResources)
  if (currentTemplateResources) {
    clonedCurrentTemplateResources.forEach((res, inx) => (res.__inx__ = inx))
  } else {
    // form didn't change anything so just use user edits
    return customResources
  }

  const {
    weakMap: weakCurrent,
    addedResources,
    removedSet: removedCurrent,
  } = mapResources(customResources, clonedCurrentTemplateResources)

  // modify
  if (clonedCurrentTemplateResources) {
    customResources.forEach((resource) => {
      // compare the difference, and add them to edit the custom resource
      const oldResource = weakBase.get(resource)
      const newResource = weakCurrent.get(resource)
      if (oldResource && newResource) {
        mergeResource(resource, oldResource, newResource)
      }
    })
  }

  // add
  if (addedResources.length) {
    customResources.push(...addedResources)
  }

  // remove
  if (removedCurrent.size) {
    // the base template has this resource, but the latest generated template doesn't,
    // so set up links that will delete those resources
    customResources = filter(customResources, removedCurrent, true)
  }

  // sort the resources to their original positions
  if (currentTemplateResources) {
    customResources.sort((a, b) => {
      return a.__inx__ - b.__inx__
    })
    customResources.forEach((res) => delete res.__inx__)
  }

  return customResources
}

const mergeOtherYAMLTabs = (otherYAMLTabs, templateResources) => {
  otherYAMLTabs.forEach((tab) => {
    const { id, templateYAML, typingYAML, typedYAML, baseTemplateYAML } = tab
    if (templateYAML && baseTemplateYAML && (typingYAML || typedYAML)) {
      let encodeYAML
      if (typingYAML) {
        tab.templateYAML = typingYAML
        encodeYAML = typingYAML
      } else if (typedYAML) {
        const resources = parseYAML(typedYAML).resources
        mergeResource(resources[0], parseYAML(baseTemplateYAML).resources[0], parseYAML(templateYAML).resources[0])
        tab.mergedTemplate = generateSourceFromResources(resources).templateYAML
        tab.templateYAML = tab.mergedTemplate
        encodeYAML = tab.mergedTemplate
      }

      // just for install-config, need to stuff encoded version into install-config secret
      if (encodeYAML && id === 'install-config') {
        templateResources.some((resource) => {
          if (resource.data && resource.data['install-config.yaml']) {
            resource.data['install-config.yaml'] = Buffer.from(encodeYAML, 'ascii').toString('base64')
            return true
          }
          return false
        })
      }
    }
  })
}

const mergeResource = (resource, oldResource, newResource) => {
  const diffs = diff(oldResource, newResource)
  if (diffs) {
    diffs.forEach(({ kind, path, rhs, item }) => {
      let val, idx
      switch (kind) {
        // array modification
        case 'A': {
          switch (item.kind) {
            case 'N':
              val = get(newResource, path, [])
              if (Array.isArray(val)) {
                set(resource, path, val)
              } else {
                val[Object.keys(val).length] = item.rhs
                set(resource, path, Object.values(val))
              }
              break
            case 'D':
              val = get(newResource, path, [])
              if (Array.isArray(val)) {
                set(resource, path, val)
              } else {
                val = omitBy(val, (e) => e === item.lhs)
                set(resource, path, Object.values(val))
              }
              break
          }
          break
        }
        case 'E': {
          idx = path.pop()
          val = get(resource, path)
          if (Array.isArray(val)) {
            val.splice(idx, 1, rhs)
          } else {
            path.push(idx)
            set(resource, path, rhs)
          }
          break
        }
        case 'N': {
          set(resource, path, rhs)
          break
        }
        case 'D': {
          unset(resource, path)
          break
        }
      }
    })
  }
}

const generateSourceFromResources = (resources) => {
  let yaml,
    row = 0
  const parsed = {}
  const yamls = []
  const sort = ['name', 'namespace']
  const sortKeys = (a, b) => {
    let ai = sort.indexOf(a)
    if (ai < 0) ai = 5
    let bi = sort.indexOf(b)
    if (bi < 0) bi = 5
    return ai - bi
  }
  resources.forEach((resource) => {
    if (!isEmpty(resource)) {
      const key = get(resource, 'kind', 'unknown')
      yaml = jsYaml.dump(resource, {
        noRefs: true,
        lineWidth: 2000,
        sortKeys,
      })
      yaml = yaml.replace(/'\d+':(\s|$)\s*/gm, '- ')
      yaml = yaml.replace(/:\s*null$/gm, ':')
      const $synced = new YamlParser().parse(yaml, row)
      $synced.$r = row
      $synced.$l = yaml.split(/[\r\n]+/g).length
      let values = parsed[key]
      if (!values) {
        values = parsed[key] = []
      }
      values.push({ $raw: resource, $yml: yaml, $synced })
      row += yaml.split('\n').length
      yamls.push(yaml)
    }
  })

  return {
    templateYAML: yamls.join('---\n'),
    templateObject: parsed,
  }
}
